'use strict';

const WebSocket = require('ws');

const WS_HEARTBEAT_INTERVAL = 5000;
const WS_RESTART_TIMEOUT = 1000;
const WS_MAX_RESTART_DELAY = 60000;
const MAX_RESTART_RETRIES = 50;
const MAX_BUFFER_SIZE = 1000;

// Modul-globale Retry-Status-Variablen (überleben Controller-Neuinstanzierung bei autoRestart)
let retryCount = 0;
let currentBackoff = WS_RESTART_TIMEOUT;
let messageBuffer = [];

/**
 * Manages the WebSocket connection to the zwave-js-ui server.
 */
class WebsocketController {
    /**
     * Creates a new WebsocketController instance.
     *
     * @param {object} adapter - The ioBroker adapter instance.
     */
    constructor(adapter) {
        this.adapter = adapter;

        // FIX: Instanz-Properties statt Modul-globaler Variablen
        this.wsClient = null;
        this.ping = null;
        this.pingTimeout = null;
        this.autoRestartTimeout = null;
    }

    /**
     * Initialises and connects the WebSocket client to the zwave-js-ui server.
     *
     * @returns {WebSocket|null} The created WebSocket client instance, or null on error.
     */
    initWsClient() {
        try {
            let wsURL = `${this.adapter.config.wsScheme}://${this.adapter.config.wsServerIP}:${this.adapter.config.wsServerPort}/api`;

            if (this.adapter.config.wsTokenEnabled === true) {
                wsURL += `?token=${this.adapter.config.wsToken}`;
            }

            this.wsClient = new WebSocket(wsURL, { rejectUnauthorized: false });

            this.wsClient.on('open', () => {
                // Bei erfolgreicher Verbindung Backoff und Retries zurücksetzen
                retryCount = 0;
                currentBackoff = WS_RESTART_TIMEOUT;
                this.adapter.log.info('<zwavews> WebSocket connected successfully.');

                // Gepufferte Nachrichten senden
                this.flushMessageBuffer();

                this.sendPingToServer();
                this.wsHeartbeat();
            });

            this.wsClient.on('pong', () => {
                this.wsHeartbeat();
            });

            this.wsClient.on('close', () => {
                clearTimeout(this.pingTimeout);
                clearTimeout(this.ping);

                if (this.wsClient.readyState === WebSocket.CLOSED) {
                    this.autoRestart();
                }
            });

            this.wsClient.on('error', (err) => {
                // FIX: err.message statt komplettes Objekt loggen
                this.adapter.log.warn(`<zwavews> WebSocket error: ${err.message}`);
            });

            return this.wsClient;
        } catch (err) {
            this.adapter.log.error(`<zwavews> initWsClient failed: ${err.message}`);
            // Trigger neu: autoRestart mit Backoff statt einfach null zurückzugeben
            this.autoRestart();
            return null;
        }
    }

    /**
     * Sends a message to the zwave-js-ui server via the WebSocket connection.
     *
     * @param {string} message - The message payload to send.
     */
    send(message) {
        // FIX: Null-Check für wsClient
        if (!this.wsClient || this.wsClient.readyState !== WebSocket.OPEN) {
            // Prüfen, ob Puffer noch nicht voll ist
            if (messageBuffer.length < MAX_BUFFER_SIZE) {
                messageBuffer.push(message);
                this.adapter.log.warn(
                    `<zwavews> Cannot send message, buffering (${messageBuffer.length}/${MAX_BUFFER_SIZE}).`,
                );
            } else {
                // Puffer voll – älteste Nachricht verwerfen und neue hinten anhängen
                const oldest = messageBuffer.shift();
                messageBuffer.push(message);
                this.adapter.log.warn(
                    `<zwavews> Buffer full, dropping oldest message: "${oldest.substring(0, 80)}${oldest.length > 80 ? '...' : ''}"`,
                );
            }
            return;
        }
        this.wsClient.send(message);
    }

    /**
     * Sends a WebSocket ping to the server and schedules the next ping.
     */
    sendPingToServer() {
        if (!this.wsClient || this.wsClient.readyState !== WebSocket.OPEN) {
            return;
        }
        this.wsClient.ping();
        this.ping = setTimeout(() => {
            this.sendPingToServer();
        }, WS_HEARTBEAT_INTERVAL);
    }

    /**
     * Resets the heartbeat timeout; terminates the connection if no pong is received in time.
     */
    wsHeartbeat() {
        clearTimeout(this.pingTimeout);
        this.pingTimeout = setTimeout(() => {
            this.adapter.log.warn('<zwavews> WebSocket connection timed out, terminating.');
            if (this.wsClient) {
                this.wsClient.terminate();
            }
        }, WS_HEARTBEAT_INTERVAL + 3000);
    }

    /**
     * Flushes the message buffer by sending all buffered messages to the server.
     * Called on successful WebSocket open.
     */
    flushMessageBuffer() {
        if (messageBuffer.length === 0) {
            return;
        }

        const count = messageBuffer.length;
        this.adapter.log.info(`<zwavews> Flushing ${count} buffered message(s)...`);

        const messages = messageBuffer.splice(0);
        for (const msg of messages) {
            if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
                this.wsClient.send(msg);
            } else {
                this.adapter.log.warn(
                    '<zwavews> Connection lost while flushing buffer, re-buffering message.',
                );
                messageBuffer.unshift(msg);
                break;
            }
        }
    }

    /**
     * Resets retry counters and clears the message buffer.
     * Should be called externally on a clean shutdown.
     */
    resetRetryState() {
        retryCount = 0;
        currentBackoff = WS_RESTART_TIMEOUT;
        messageBuffer = [];
    }

    /**
     * Schedules an automatic reconnect attempt after the configured restart timeout.
     */
    autoRestart() {
        retryCount++;

        if (retryCount > MAX_RESTART_RETRIES) {
            this.adapter.log.error(
                `<zwavews> Max restart retries (${MAX_RESTART_RETRIES}) reached. ` +
                    `Giving up — manual intervention required. Restart the adapter to try again.`,
            );
            return;
        }

        const delay = Math.min(currentBackoff, WS_MAX_RESTART_DELAY);
        this.adapter.log.warn(
            `<zwavews> WebSocket closed, reconnecting in ${delay / 1000}s... ` +
                `(attempt ${retryCount}/${MAX_RESTART_RETRIES})`,
        );

        this.autoRestartTimeout = setTimeout(() => {
            // Backoff verdoppeln für den nächsten Versuch
            currentBackoff = Math.min(currentBackoff * 2, WS_MAX_RESTART_DELAY);
            this.adapter.startWebsocket();
        }, delay);
    }

    /**
     * Closes the WebSocket connection if it is currently open.
     */
    closeConnection() {
        if (this.wsClient && this.wsClient.readyState !== WebSocket.CLOSED) {
            this.wsClient.close();
        }
    }

    /**
     * Clears all active timers (ping, pingTimeout, autoRestartTimeout).
     */
    allTimerClear() {
        clearTimeout(this.pingTimeout);
        clearTimeout(this.ping);
        clearTimeout(this.autoRestartTimeout);
    }
}

module.exports = {
    WebsocketController,
};
