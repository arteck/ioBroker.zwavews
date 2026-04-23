'use strict';

const WebSocket = require('ws');

const WS_HEARTBEAT_INTERVAL = 5000;
const WS_RESTART_TIMEOUT = 1000;

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
            this.adapter.log.warn('<zwavews> Cannot send message, no open websocket connection to zwave-js-ui.');
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
     * Schedules an automatic reconnect attempt after the configured restart timeout.
     */
    autoRestart() {
        this.adapter.log.warn(`<zwavews> WebSocket closed, reconnecting in ${WS_RESTART_TIMEOUT / 1000}s...`);
        this.autoRestartTimeout = setTimeout(() => {
            this.adapter.startWebsocket();
        }, WS_RESTART_TIMEOUT);
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
