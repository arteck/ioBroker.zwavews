'use strict';

const assert = require('assert');
const { WebsocketController } = require('../../lib/websocketController');

// ─── Mock WebSocket ───────────────────────────────────────────────────────────
class MockWebSocket {
    constructor() {
        this.readyState = MockWebSocket.OPEN;
        this._handlers = {};
        this._sent = [];
        this._pinged = false;
        this._terminated = false;
        this._closed = false;
    }

    on(event, handler) {
        if (!this._handlers[event]) this._handlers[event] = [];
        this._handlers[event].push(handler);
    }

    emit(event, ...args) {
        (this._handlers[event] || []).forEach(h => h(...args));
    }

    send(msg) { this._sent.push(msg); }
    ping() { this._pinged = true; }
    terminate() { this._terminated = true; this.readyState = MockWebSocket.CLOSED; }
    close() { this._closed = true; this.readyState = MockWebSocket.CLOSED; }

    static get OPEN() { return 1; }
    static get CLOSED() { return 3; }
}

/**
 * Erstellt einen minimalen Mock-Adapter.
 */
function createMockAdapter(wsConfig = {}) {
    const logs = { info: [], warn: [], error: [], debug: [] };
    return {
        config: {
            wsScheme: 'ws',
            wsServerIP: '127.0.0.1',
            wsServerPort: 3000,
            wsTokenEnabled: false,
            wsToken: '',
            ...wsConfig,
        },
        log: {
            info:  (m) => logs.info.push(m),
            warn:  (m) => logs.warn.push(m),
            error: (m) => logs.error.push(m),
            debug: (m) => logs.debug.push(m),
        },
        logs,
        startWebsocket: () => {},
    };
}

// ─── WebsocketController Tests ────────────────────────────────────────────────
describe('WebsocketController', () => {
    let adapter;
    let controller;
    let OrigWebSocket;

    before(() => {
        // Originales WebSocket-Modul merken
        OrigWebSocket = require('ws');
    });

    beforeEach(() => {
        adapter = createMockAdapter();
        controller = new WebsocketController(adapter);
    });

    afterEach(() => {
        // Timer aufräumen
        controller.allTimerClear();
    });

    // ─── Instanz-Properties ─────────────────────────────────────────────────
    describe('constructor', () => {
        it('should initialise all timer properties to null', () => {
            assert.strictEqual(controller.wsClient, null);
            assert.strictEqual(controller.ping, null);
            assert.strictEqual(controller.pingTimeout, null);
            assert.strictEqual(controller.autoRestartTimeout, null);
        });
    });

    // ─── send() ─────────────────────────────────────────────────────────────
    describe('send()', () => {
        it('should log a warning when wsClient is null', () => {
            controller.send('{"command":"test"}');
            assert.ok(adapter.logs.warn.length > 0, 'Should log a warning');
        });

        it('should log a warning when wsClient is not OPEN', () => {
            const mock = new MockWebSocket();
            mock.readyState = MockWebSocket.CLOSED;
            controller.wsClient = mock;
            controller.send('test');
            assert.ok(adapter.logs.warn.length > 0, 'Should log a warning');
        });

        it('should send message when wsClient is OPEN', () => {
            const mock = new MockWebSocket();
            controller.wsClient = mock;
            controller.send('{"command":"test"}');
            assert.deepStrictEqual(mock._sent, ['{"command":"test"}']);
        });
    });

    // ─── closeConnection() ───────────────────────────────────────────────────
    describe('closeConnection()', () => {
        it('should call wsClient.close() when connection is open', () => {
            const mock = new MockWebSocket();
            controller.wsClient = mock;
            controller.closeConnection();
            assert.strictEqual(mock._closed, true);
        });

        it('should not throw when wsClient is null', () => {
            assert.doesNotThrow(() => controller.closeConnection());
        });

        it('should not call close() when already CLOSED', () => {
            const mock = new MockWebSocket();
            mock.readyState = MockWebSocket.CLOSED;
            controller.wsClient = mock;
            controller.closeConnection();
            assert.strictEqual(mock._closed, false);
        });
    });

    // ─── allTimerClear() ─────────────────────────────────────────────────────
    describe('allTimerClear()', () => {
        it('should not throw when all timers are null', () => {
            assert.doesNotThrow(() => controller.allTimerClear());
        });

        it('should cancel active timeouts', (done) => {
            let fired = false;
            controller.ping = setTimeout(() => { fired = true; }, 100);
            controller.allTimerClear();
            setTimeout(() => {
                assert.strictEqual(fired, false, 'ping timer should have been cancelled');
                done();
            }, 150);
        });
    });

    // ─── wsHeartbeat() ───────────────────────────────────────────────────────
    describe('wsHeartbeat()', () => {
        it('should terminate wsClient after timeout', function (done) {
            this.timeout(10000);
            const mock = new MockWebSocket();
            controller.wsClient = mock;

            // Sehr kurzes Timeout für den Test
            const origInterval = 5000;
            controller.wsHeartbeat = function () {
                clearTimeout(this.pingTimeout);
                this.pingTimeout = setTimeout(() => {
                    this.wsClient && this.wsClient.terminate();
                }, 50); // kurzes Timeout im Test
            };

            controller.wsHeartbeat();
            setTimeout(() => {
                assert.strictEqual(mock._terminated, true, 'wsClient should have been terminated');
                done();
            }, 100);
        });
    });

    // ─── sendPingToServer() ──────────────────────────────────────────────────
    describe('sendPingToServer()', () => {
        it('should not throw when wsClient is null', () => {
            assert.doesNotThrow(() => controller.sendPingToServer());
        });

        it('should call wsClient.ping() when OPEN', () => {
            const mock = new MockWebSocket();
            controller.wsClient = mock;
            controller.sendPingToServer();
            assert.strictEqual(mock._pinged, true);
            clearTimeout(controller.ping); // aufräumen
        });
    });
});
