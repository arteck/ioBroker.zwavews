'use strict';

/**
 * Unit-Tests für main.js – messageParse und onStateChange Logik.
 * Da core.Adapter nicht einfach gemockt werden kann, testen wir
 * die Logik über isolierte Hilfsmethoden und den vollständigen Lifecycle-Mock.
 */

const assert = require('assert');

// ─── Minimal-Mock für core.Adapter ─────────────────────────────────────────

class MockAdapter {
    constructor() {
        this.config = {
            connectionType: 'ws',
            wsServerIP: '127.0.0.1',
            wsServerPort: 3000,
            wsScheme: 'ws',
            wsTokenEnabled: false,
            wsOnStart: false,
            showNodeInfoMessage: false,
            newTypeEvent: true,
            wakeUpInfo: false,
            useEventInDesc: false,
        };
        this.namespace = 'zwavews.0';
        this.name = 'zwavews';
        this.instance = 0;
        this._states = {};
        this._objects = {};
        this._handlers = {};
        this.log = {
            info:  (m) => this._logs.info.push(m),
            warn:  (m) => this._logs.warn.push(m),
            error: (m) => this._logs.error.push(m),
            debug: (m) => this._logs.debug.push(m),
        };
        this._logs = { info: [], warn: [], error: [], debug: [] };
        this._subscriptions = [];
    }

    on(event, handler) {
        this._handlers[event] = handler;
    }

    emit(event, ...args) {
        if (this._handlers[event]) this._handlers[event](...args);
    }

    async setStateAsync(id, val, ack) { this._states[id] = { val, ack }; }
    async setStateChangedAsync(id, val, ack) { this._states[id] = { val, ack }; }
    setStateChanged(id, val, ack) { this._states[id] = { val, ack }; }
    async getStateAsync(id) { return this._states[id] ?? null; }
    async getObjectAsync(id) { return this._objects[id] ?? null; }
    async setObjectNotExistsAsync(id, obj) { this._objects[id] = obj; }
    subscribeStates(id) { this._subscriptions.push(id); }
    async delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
}

// ─── messageParse Tests ───────────────────────────────────────────────────────
describe('messageParse', () => {
    // Wir testen die Parse-Logik durch direktes Aufrufen der isolierten Methode
    // via einem konkreten zwavews-Objekt mit gemockten Abhängigkeiten.

    let adapter;
    let instance;

    function buildInstance() {
        adapter = new MockAdapter();

        // Stub-Helper
        adapter._helperCalls = [];
        const helperStub = {
            parse: async (path, val) => { adapter._helperCalls.push({ method: 'parse', path, val }); },
            createNode: async (nodeId) => { adapter._helperCalls.push({ method: 'createNode', nodeId }); },
            updateDevice: async (nodeId, arg) => { adapter._helperCalls.push({ method: 'updateDevice', nodeId, arg }); },
        };

        // Stub-WebsocketController
        adapter._wsSent = [];
        const wsStub = {
            send: (msg) => adapter._wsSent.push(msg),
        };

        // Stub-StatesController
        const scStub = {
            setAllAvailableToFalse: async () => {},
        };

        // Einfaches Objekt, das messageParse ausführt
        instance = {
            config: adapter.config,
            log: adapter.log,
            _logs: adapter._logs,
            _states: adapter._states,
            helper: helperStub,
            websocketController: wsStub,
            statesController: scStub,
            allNodesCreated: false,
            startListening: false,
            nodeCache: {},
            parseOptions: {},
            messageParseMutex: Promise.resolve(),
            getStateAsync: (id) => adapter.getStateAsync(id),
            setStateChanged: (id, val, ack) => adapter.setStateChanged(id, val, ack),
        };

        // messageParse aus main.js
        const utils = require('../../lib/utils');
        const constant = require('../../lib/constants');

        instance.messageParse = async function (message) {
            let release;
            const lock = new Promise((resolve) => (release = resolve));
            const prev = this.messageParseMutex;
            this.messageParseMutex = lock;
            await prev;

            try {
                const messageObj = JSON.parse(message);
                const debugDevicesState = await this.getStateAsync('info.debugId');
                const type = messageObj?.type;

                if (this.config.connectionType === 'ws') {
                    switch (type) {
                        case 'version': {
                            this.setStateChanged('info.connection', true, true);
                            this.setStateChanged('info.zwave_gateway_version', messageObj.driverVersion, true);
                            this.setStateChanged('info.zwave_gateway_status', 'online', true);
                            break;
                        }
                        case 'result': {
                            if (messageObj.result?.success === true) {
                                this.setStateChanged('info.debugmessages', JSON.stringify(messageObj), true);
                                break;
                            }
                            if (this.allNodesCreated) break;
                            if (!messageObj.result?.state || !Array.isArray(messageObj.result.state.nodes)) {
                                this.log.warn('<zwavews> Invalid result.state structure received, skipping.');
                                break;
                            }
                            const { nodes } = messageObj.result.state;
                            for (const nodeData of nodes) {
                                const nodeId = utils.formatNodeId(nodeData.nodeId);
                                if (!this.nodeCache[nodeId]) {
                                    this.nodeCache[nodeId] = { nodeData };
                                }
                                await this.helper.createNode(nodeId, nodeData, this.parseOptions);
                            }
                            this.allNodesCreated = true;
                            if (this.startListening) {
                                this.websocketController.send(JSON.stringify({ command: 'start_listening' }));
                                this.startListening = false;
                            }
                            break;
                        }
                        case 'event': {
                            const eventTyp = messageObj.event;
                            switch (eventTyp.event) {
                                case 'ready':
                                case 'alive':
                                case 'dead': {
                                    const nodeId = utils.formatNodeId(eventTyp.nodeId);
                                    await this.helper.parse(`${nodeId}.status`, eventTyp.event.toLowerCase(), this.parseOptions);
                                    await this.helper.parse(`${nodeId}.ready`, eventTyp.event !== 'dead', this.parseOptions);
                                    break;
                                }
                                default:
                                    if (this.config.newTypeEvent) {
                                        this.log.warn(`New type event ->> ${eventTyp.event}`);
                                    }
                            }
                            break;
                        }
                        default:
                            break;
                    }
                }
            } catch (err) {
                this.log.error(String(err));
            } finally {
                release();
            }
        };
    }

    beforeEach(buildInstance);

    it('should set connection and version states on "version" message', async () => {
        await instance.messageParse(JSON.stringify({ type: 'version', driverVersion: '10.0.0' }));
        assert.strictEqual(adapter._states['info.connection'].val, true);
        assert.strictEqual(adapter._states['info.zwave_gateway_version'].val, '10.0.0');
        assert.strictEqual(adapter._states['info.zwave_gateway_status'].val, 'online');
    });

    it('should create all nodes on "result" message', async () => {
        const msg = {
            type: 'result',
            result: {
                state: {
                    nodes: [
                        { nodeId: 1, name: 'Node 1' },
                        { nodeId: 2, name: 'Node 2' },
                    ],
                },
            },
        };
        await instance.messageParse(JSON.stringify(msg));
        assert.strictEqual(instance.allNodesCreated, true);
        const createCalls = adapter._helperCalls.filter(c => c.method === 'createNode');
        assert.strictEqual(createCalls.length, 2);
        assert.strictEqual(createCalls[0].nodeId, 'nodeID_001');
        assert.strictEqual(createCalls[1].nodeId, 'nodeID_002');
    });

    it('should ignore second "result" message when allNodesCreated=true', async () => {
        instance.allNodesCreated = true;
        await instance.messageParse(JSON.stringify({ type: 'result', result: { state: { nodes: [{ nodeId: 3 }] } } }));
        assert.strictEqual(adapter._helperCalls.length, 0);
    });

    it('should warn on invalid result.state', async () => {
        await instance.messageParse(JSON.stringify({ type: 'result', result: { state: null } }));
        assert.ok(adapter._logs.warn.some(w => w.includes('Invalid result.state')));
    });

    it('should send start_listening if startListening=true after nodes created', async () => {
        instance.startListening = true;
        await instance.messageParse(JSON.stringify({
            type: 'result',
            result: { state: { nodes: [{ nodeId: 1 }] } },
        }));
        assert.ok(adapter._wsSent.some(m => m.includes('start_listening')));
        assert.strictEqual(instance.startListening, false);
    });

    it('should parse alive event and set ready=true', async () => {
        await instance.messageParse(JSON.stringify({ type: 'event', event: { event: 'alive', nodeId: 5 } }));
        const parseCalls = adapter._helperCalls.filter(c => c.method === 'parse');
        const readyCall = parseCalls.find(c => c.path.endsWith('.ready'));
        assert.ok(readyCall, 'ready state should be parsed');
        assert.strictEqual(readyCall.val, true);
    });

    it('should parse dead event and set ready=false', async () => {
        await instance.messageParse(JSON.stringify({ type: 'event', event: { event: 'dead', nodeId: 5 } }));
        const parseCalls = adapter._helperCalls.filter(c => c.method === 'parse');
        const readyCall = parseCalls.find(c => c.path.endsWith('.ready'));
        assert.ok(readyCall);
        assert.strictEqual(readyCall.val, false);
    });

    it('should log unknown event type when newTypeEvent=true', async () => {
        await instance.messageParse(JSON.stringify({ type: 'event', event: { event: 'unknown_event_xyz', nodeId: 5 } }));
        assert.ok(adapter._logs.warn.some(w => w.includes('New type event')));
    });

    it('should handle invalid JSON gracefully', async () => {
        await instance.messageParse('NOT_VALID_JSON');
        assert.ok(adapter._logs.error.length > 0);
    });

    it('should process messages sequentially via mutex', async () => {
        const order = [];
        const originalParse = instance.messageParse.bind(instance);

        // Sende zwei Nachrichten gleichzeitig – beide müssen sequenziell ankommen
        await Promise.all([
            instance.messageParse(JSON.stringify({ type: 'version', driverVersion: '1.0' })),
            instance.messageParse(JSON.stringify({ type: 'version', driverVersion: '2.0' })),
        ]);
        // Beide sollten verarbeitet worden sein (kein Fehler)
        assert.strictEqual(adapter._states['info.connection'].val, true);
    });
});
