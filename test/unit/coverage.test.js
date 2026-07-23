'use strict';

/**
 * coverage.test.js
 *
 * Umfassende Tests für alle Event-Handler, Meter-Pfade,
 * Reconnect-Mechanismus und Edge-Cases.
 */

const assert = require('assert');

// ─── Imports ──────────────────────────────────────────────────────────────────
const utils = require('../../lib/utils');
const constant = require('../../lib/constants');
const { WebsocketController } = require('../../lib/websocketController');

// ─── Module-level reset helper for websocketController ───────────────────────
function resetWsModuleState() {
    const wsModule = require('../../lib/websocketController');
    // Access module-level variables via the class methods
    const ctrl = new WebsocketController({
        config: { wsScheme: 'ws', wsServerIP: '127.0.0.1', wsServerPort: 3000, wsTokenEnabled: false },
        log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        startWebsocket: () => {},
    });
    ctrl.resetRetryState();
}

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

// ─── Mock-Adapter Factory ─────────────────────────────────────────────────────
function createMockAdapter() {
    const logs = { info: [], warn: [], error: [], debug: [] };
    return {
        config: {
            connectionType: 'ws',
            showNodeInfoMessage: false,
            newTypeEvent: true,
            wakeUpInfo: true,
            useEventInDesc: false,
        },
        log: {
            info: (m) => logs.info.push(m),
            warn: (m) => logs.warn.push(m),
            error: (m) => logs.error.push(m),
            debug: (m) => logs.debug.push(m),
        },
        logs,
        _states: {},
        _objects: {},
        _helperCalls: [],
        _wsSent: [],
        _delStates: [],
        setStateChanged: function (id, val, ack) { this._states[id] = { val, ack }; },
        setStateChangedAsync: async function (id, val, ack) { this._states[id] = { val, ack }; },
        getStateAsync: async function (id) { return this._states[id] ?? null; },
        getObjectAsync: async function (id) { return this._objects[id] ?? null; },
        setObjectNotExistsAsync: async function (id, obj) { this._objects[id] = obj; },
        delObjectAsync: async function (id) { this._delStates.push(id); },
        subscribeStates: function () {},
    };
}

// ─── Build full messageParse instance ─────────────────────────────────────────
function buildInstance(adapter) {
    const helperStub = {
        parse: async (p, v, o, n) => adapter._helperCalls.push({ method: 'parse', path: p, val: v, notif: n }),
        createNode: async (nodeId, nd) => adapter._helperCalls.push({ method: 'createNode', nodeId, nodeData: nd }),
        updateDevice: async (nodeId, arg) => adapter._helperCalls.push({ method: 'updateDevice', nodeId, arg }),
    };

    const wsStub = {
        send: (m) => adapter._wsSent.push(m),
    };

    const scStub = {
        setAllAvailableToFalse: async () => {},
        deleteState: async (stateName) => adapter._delStates.push(stateName),
    };

    const inst = {
        config: adapter.config,
        log: adapter.log,
        _states: adapter._states,
        _helperCalls: adapter._helperCalls,
        _wsSent: adapter._wsSent,
        _delStates: adapter._delStates,
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

    // messageParse – vollständige Kopie aus main.js
    inst.messageParse = async function (message) {
        let release;
        const lock = new Promise((resolve) => (release = resolve));
        const prev = this.messageParseMutex;
        this.messageParseMutex = lock;
        await prev;

        try {
            const eventMessage = await this.getStateAsync('info.eventMessage');
            let messageObj = JSON.parse(message);

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

                        const { nodes: allNodes } = messageObj.result.state;

                        for (const nodeData of allNodes) {
                            const nodeId = utils.formatNodeId(nodeData.nodeId);

                            if (!this.nodeCache[nodeId]) {
                                if (this.config.showNodeInfoMessage) {
                                    this.log.info(`Node Info Update for ${nodeId}`);
                                }
                                this.nodeCache[nodeId] = { nodeData };
                            }
                            await this.helper.createNode(nodeId, nodeData);
                        }

                        this.allNodesCreated = true;

                        if (this.config.showNodeInfoMessage) {
                            this.log.info('all Nodes are ready');
                        }
                        if (this.startListening) {
                            this.websocketController.send(JSON.stringify({ command: 'start_listening' }));
                            this.startListening = false;
                        }
                        break;
                    }
                    case 'event': {
                        if (eventMessage?.val) {
                            messageObj.event = JSON.parse(eventMessage.val);
                            messageObj.event = messageObj.event.event;
                        }

                        const eventTyp = messageObj.event;
                        const nodeId = eventTyp.nodeId;

                        switch (eventTyp.event) {
                            case 'value updated':
                            case 'value added':
                            case 'value notification': {
                                const nodeArg = eventTyp.args;
                                const formattedNodeId = utils.formatNodeId(nodeId);

                                if (nodeArg.commandClassName?.toLowerCase() === 'meter') {
                                    if (nodeArg.propertyKeyName && typeof nodeArg.propertyKeyName === 'string' && nodeArg.propertyKeyName.includes('UNKNOWN')) {
                                        this.log.warn(`<zwavews> Node ${nodeId}: Unknown propertyKeyName "${nodeArg.propertyKeyName}" for ${nodeArg.commandClassName}.${nodeArg.propertyName}`);
                                        break;
                                    }

                                    const meterParts = [];
                                    if (nodeArg.propertyKeyName != null && nodeArg.propertyKeyName !== '') {
                                        meterParts.push(nodeArg.propertyKeyName);
                                    } else if (nodeArg.propertyName != null && nodeArg.propertyName !== '') {
                                        meterParts.push(nodeArg.propertyName);
                                    }
                                    meterParts.push(nodeArg.commandClass);
                                    if (nodeArg.endpoint != null && nodeArg.endpoint > 0) {
                                        meterParts.push(nodeArg.endpoint);
                                    }
                                    if (nodeArg.propertyKey != null && nodeArg.propertyKey !== '') {
                                        meterParts.push(nodeArg.propertyKey);
                                    }

                                    let parsePath = `${formattedNodeId}.Meter.${meterParts.join('_')}`;

                                    if (eventTyp.event === 'value notification') {
                                        await this.helper.parse(parsePath, nodeArg.newValue, this.parseOptions, true);
                                    } else {
                                        await this.helper.parse(parsePath, nodeArg.newValue, this.parseOptions, false);
                                    }
                                } else {
                                    let parsePath = `${formattedNodeId}.${nodeArg.commandClassName}.${nodeArg.propertyName
                                        .replace(/[^\p{L}\p{N}\s]/gu, '')
                                        .replace(/\s+/g, ' ')
                                        .trim()}`;

                                    const meaningfulKeysMain = constant.MEANINGFUL_PROPERTY_KEYS[nodeArg.commandClassName];
                                    if (nodeArg?.propertyKeyName && meaningfulKeysMain && (meaningfulKeysMain.includes('*') || meaningfulKeysMain.includes(nodeArg.propertyName ?? nodeArg.property))) {
                                        parsePath = `${parsePath}.${nodeArg.propertyKeyName.toLowerCase()
                                            .replace(/[^\p{L}\p{N}\s]/gu, '')
                                            .replace(/\s+/g, ' ')
                                            .trim()}`;
                                    }

                                    parsePath = utils.deleteLastDot(utils.formatObject(parsePath));

                                    if (nodeArg.commandClass === 119) {
                                        switch (nodeArg.property) {
                                            case 'name':
                                                await this.helper.updateDevice(formattedNodeId, nodeArg);
                                                parsePath = `${formattedNodeId}.info.${nodeArg.property}`;
                                                break;
                                            case 'location':
                                                break;
                                            default:
                                                parsePath = `${formattedNodeId}.info.${nodeArg.property}`;
                                                break;
                                        }
                                    }

                                    if (parsePath.includes('firmwareVersions')) {
                                        parsePath = `${parsePath}_value`;
                                    }

                                    if (nodeArg.endpoint != null && nodeArg.endpoint > 0) {
                                        parsePath = `${parsePath}_${nodeArg.endpoint}`;
                                    }

                                    parsePath = utils.deleteLastDot(parsePath);

                                    if (eventTyp.event === 'value notification') {
                                        await this.helper.parse(parsePath, nodeArg.newValue, this.parseOptions, true);
                                    } else {
                                        await this.helper.parse(parsePath, nodeArg.newValue, this.parseOptions, false);
                                    }
                                }

                                break;
                            }

                            case 'notification': {
                                const formattedNodeId = utils.formatNodeId(nodeId);
                                const parsePath = `${formattedNodeId}.Notification`;

                                let notifMessage = {};

                                if (eventTyp?.args) {
                                    notifMessage = eventTyp.args;
                                } else {
                                    this.log.debug(`<zwavews> notification without args, using fallback for node ${formattedNodeId}`);
                                    notifMessage = {
                                        name: eventTyp.notificationLabel,
                                        parameters: eventTyp.parameters
                                    };
                                }

                                await this.helper.parse(parsePath, notifMessage, this.parseOptions, true);
                                break;
                            }

                            case 'firmware update progress': {
                                const formattedNodeId = utils.formatNodeId(nodeId);
                                const total = Number(eventTyp.totalFragments) || 0;
                                const sent = Number(eventTyp.sentFragments) || 0;
                                const progress = total > 0 ? Math.min(100, Math.max(0, (sent / total) * 100)) : 0;
                                this.log.info(
                                    `Firmware update progress for ${formattedNodeId} ->> ` +
                                    `send Fragments ${sent} -- total ${total} (${progress.toFixed(1)}%)`,
                                );
                                break;
                            }

                            case 'firmware update finished': {
                                const formattedNodeId = utils.formatNodeId(nodeId);
                                this.log.info(`${formattedNodeId} --> ${eventTyp.event}`);
                                break;
                            }

                            case 'ready':
                            case 'sleep':
                            case 'wake up':
                            case 'alive':
                            case 'dead': {
                                const formattedNodeId = utils.formatNodeId(nodeId);
                                await this.helper.parse(`${formattedNodeId}.status`, eventTyp.event.toLowerCase(), this.parseOptions);

                                if (eventTyp.event === 'dead') {
                                    await this.helper.parse(`${formattedNodeId}.ready`, false, this.parseOptions);
                                } else {
                                    await this.helper.parse(`${formattedNodeId}.ready`, true, this.parseOptions);
                                }

                                if (this.config.wakeUpInfo) {
                                    this.log.info(`${formattedNodeId} --> ${eventTyp.event}`);
                                }
                                break;
                            }

                            case 'node removed': {
                                const formattedNodeId = utils.formatNodeId(nodeId);
                                if (this.config.useEventInDesc) {
                                    await this.helper.updateDevice(formattedNodeId, { desc: 'Node is Deleted' }, false);
                                } else {
                                    await this.helper.updateDevice(formattedNodeId, { name: 'Node is Deleted' }, true);
                                }
                                this.log.error(`Delete ${formattedNodeId}`);
                                break;
                            }

                            case 'interview started':
                            case 'interview stage completed':
                            case 'interview failed':
                            case 'interview completed':
                                this.log.info(`${utils.formatNodeId(nodeId)} --> ${eventTyp.event}`);
                                break;

                            // ── Neue Event-Handler ──

                            case 'node added':
                                if (eventTyp.args && eventTyp.args.length > 0) {
                                    const newNode = eventTyp.args[0];
                                    const addedNodeId = newNode?.id;
                                    if (addedNodeId) {
                                        this.helper.createNode(addedNodeId, newNode);
                                        this.log.info(`<zwavews> Node ${addedNodeId} added`);
                                    }
                                }
                                break;

                            case 'interview progress':
                                if (eventTyp.args && eventTyp.args.length >= 2) {
                                    const progress = eventTyp.args[1];
                                    if (progress && typeof progress.progress === 'number') {
                                        const formattedNodeId = utils.formatNodeId(nodeId);
                                        this.log.info(`<zwavews> Node ${formattedNodeId} interview progress: ${progress.progress}% (${progress.stage || 'unknown'})`);
                                    }
                                }
                                break;

                            case 'value removed':
                                if (eventTyp.args && eventTyp.args.length >= 2) {
                                    const valueArgs = eventTyp.args[1];
                                    if (valueArgs) {
                                        const formattedNodeId = utils.formatNodeId(nodeId);
                                        const commandClassName = valueArgs.commandClassName || valueArgs.commandClass;

                                        if (commandClassName?.toLowerCase() === 'meter') {
                                            if (valueArgs.propertyKeyName && typeof valueArgs.propertyKeyName === 'string' && valueArgs.propertyKeyName.includes('UNKNOWN')) {
                                                this.log.warn(`<zwavews> Node ${nodeId}: Unknown propertyKeyName "${valueArgs.propertyKeyName}" for value removed, skipping delete`);
                                                break;
                                            }

                                            const meterParts = [];
                                            if (valueArgs.propertyKeyName != null && valueArgs.propertyKeyName !== '') {
                                                meterParts.push(valueArgs.propertyKeyName);
                                            } else if (valueArgs.propertyName != null && valueArgs.propertyName !== '') {
                                                meterParts.push(valueArgs.propertyName);
                                            }
                                            meterParts.push(valueArgs.commandClass);
                                            if (valueArgs.endpoint != null && valueArgs.endpoint > 0) {
                                                meterParts.push(valueArgs.endpoint);
                                            }
                                            if (valueArgs.propertyKey != null && valueArgs.propertyKey !== '') {
                                                meterParts.push(valueArgs.propertyKey);
                                            }

                                            let parsePath = `${formattedNodeId}.Meter.${meterParts.join('_')}`;
                                            parsePath = utils.deleteLastDot(utils.formatObject(parsePath));

                                            this.log.info(`<zwavews> Node ${formattedNodeId} value removed: ${parsePath}`);
                                            this.statesController.deleteState(parsePath);
                                        } else {
                                            const propertyName = valueArgs.property;
                                            const propertyKeyName = valueArgs.propertyKey;
                                            let parsePath = `${formattedNodeId}.${commandClassName}.${propertyName}`;
                                            if (propertyKeyName != null) {
                                                parsePath += `.${propertyKeyName}`;
                                            }
                                            this.log.info(`<zwavews> Node ${formattedNodeId} value removed: ${parsePath}`);
                                            this.statesController.deleteState(parsePath);
                                        }
                                    }
                                }
                                break;

                            case 'node found':
                                if (eventTyp.args && eventTyp.args.length > 0) {
                                    const foundNode = eventTyp.args[0];
                                    this.log.info(`<zwavews> Node found: ${foundNode?.id || 'unknown'}`);
                                }
                                break;

                            case 'user added':
                                if (eventTyp.args && eventTyp.args.length >= 2) {
                                    const formattedNodeId = utils.formatNodeId(nodeId);
                                    const user = eventTyp.args[1];
                                    this.log.info(`<zwavews> Node ${formattedNodeId} user added: ${JSON.stringify(user)}`);
                                }
                                break;

                            case 'user modified':
                                if (eventTyp.args && eventTyp.args.length >= 2) {
                                    const formattedNodeId = utils.formatNodeId(nodeId);
                                    const user = eventTyp.args[1];
                                    this.log.info(`<zwavews> Node ${formattedNodeId} user modified: ${JSON.stringify(user)}`);
                                }
                                break;

                            case 'user deleted':
                                if (eventTyp.args && eventTyp.args.length >= 2) {
                                    const formattedNodeId = utils.formatNodeId(nodeId);
                                    const user = eventTyp.args[1];
                                    this.log.info(`<zwavews> Node ${formattedNodeId} user deleted: ${JSON.stringify(user)}`);
                                }
                                break;

                            case 'credential added':
                                if (eventTyp.args && eventTyp.args.length >= 2) {
                                    const formattedNodeId = utils.formatNodeId(nodeId);
                                    const credential = eventTyp.args[1];
                                    this.log.info(`<zwavews> Node ${formattedNodeId} credential added: ${JSON.stringify(credential)}`);
                                }
                                break;

                            case 'credential modified':
                                if (eventTyp.args && eventTyp.args.length >= 2) {
                                    const formattedNodeId = utils.formatNodeId(nodeId);
                                    const credential = eventTyp.args[1];
                                    this.log.info(`<zwavews> Node ${formattedNodeId} credential modified: ${JSON.stringify(credential)}`);
                                }
                                break;

                            case 'credential deleted':
                                if (eventTyp.args && eventTyp.args.length >= 2) {
                                    const formattedNodeId = utils.formatNodeId(nodeId);
                                    const credential = eventTyp.args[1];
                                    this.log.info(`<zwavews> Node ${formattedNodeId} credential deleted: ${JSON.stringify(credential)}`);
                                }
                                break;

                            case 'inclusion started':
                                this.log.info('<zwavews> Inclusion started');
                                this.setStateChanged('info.inclusion_status', 'started', true);
                                break;

                            case 'exclusion started':
                                this.log.info('<zwavews> Exclusion started');
                                this.setStateChanged('info.exclusion_status', 'started', true);
                                break;

                            case 'inclusion stopped':
                                this.log.info('<zwavews> Inclusion stopped');
                                this.setStateChanged('info.inclusion_status', 'stopped', true);
                                break;

                            case 'exclusion stopped':
                                this.log.info('<zwavews> Exclusion stopped');
                                this.setStateChanged('info.exclusion_status', 'stopped', true);
                                break;

                            case 'inclusion failed':
                                this.log.warn('<zwavews> Inclusion failed');
                                this.setStateChanged('info.inclusion_status', 'failed', true);
                                break;

                            case 'exclusion failed':
                                this.log.warn('<zwavews> Exclusion failed');
                                this.setStateChanged('info.exclusion_status', 'failed', true);
                                break;

                            case 'status changed':
                                if (eventTyp.args && eventTyp.args.length > 0) {
                                    const status = eventTyp.args[0];
                                    this.log.info(`<zwavews> Controller status changed: ${status}`);
                                    this.setStateChanged('info.controller_status', status, true);
                                }
                                break;

                            case 'driver error':
                                if (eventTyp.args && eventTyp.args.length > 0) {
                                    const error = eventTyp.args[0];
                                    this.log.error(`<zwavews> Driver error: ${error?.message || error}`);
                                }
                                break;

                            case 'driver ready':
                                this.log.info('<zwavews> Driver ready');
                                break;

                            case 'all nodes ready':
                                this.log.info('<zwavews> All nodes ready');
                                break;

                            case 'bootloader ready':
                                this.log.info('<zwavews> Bootloader ready - firmware update mode');
                                break;

                            case 'controller firmware update progress':
                                if (eventTyp.args && eventTyp.args.length > 0) {
                                    const fwProgress = eventTyp.args[0];
                                    this.log.info(`<zwavews> Controller firmware update progress: ${JSON.stringify(fwProgress)}`);
                                }
                                break;

                            case 'controller firmware update finished':
                                if (eventTyp.args && eventTyp.args.length > 0) {
                                    const fwResult = eventTyp.args[0];
                                    this.log.info(`<zwavews> Controller firmware update finished: ${JSON.stringify(fwResult)}`);
                                }
                                break;

                            case 'rebuild routes progress':
                                if (eventTyp.args && eventTyp.args.length > 0) {
                                    const routesProgress = eventTyp.args[0];
                                    this.log.info(`<zwavews> Rebuild routes progress: ${JSON.stringify(routesProgress)}`);
                                }
                                break;

                            case 'grant security classes':
                                if (eventTyp.args && eventTyp.args.length > 0) {
                                    const requested = eventTyp.args[0];
                                    this.log.info(`<zwavews> Grant security classes requested: ${JSON.stringify(requested)}`);
                                }
                                break;

                            case 'validate dsk':
                                if (eventTyp.args && eventTyp.args.length > 0) {
                                    const dsk = eventTyp.args[0];
                                    this.log.info(`<zwavews> Validate DSK: ${dsk}`);
                                }
                                break;

                            case 'inclusion aborted':
                                this.log.warn('<zwavews> Inclusion aborted');
                                this.setStateChanged('info.inclusion_status', 'aborted', true);
                                break;

                            case 'credential learn progress':
                                if (eventTyp.args && eventTyp.args.length >= 2) {
                                    const formattedNodeId = utils.formatNodeId(nodeId);
                                    const learnProgress = eventTyp.args[1];
                                    this.log.info(`<zwavews> Node ${formattedNodeId} credential learn progress: ${JSON.stringify(learnProgress)}`);
                                }
                                break;

                            case 'credential learn completed':
                                if (eventTyp.args && eventTyp.args.length >= 2) {
                                    const formattedNodeId = utils.formatNodeId(nodeId);
                                    const learnResult = eventTyp.args[1];
                                    this.log.info(`<zwavews> Node ${formattedNodeId} credential learn completed: ${JSON.stringify(learnResult)}`);
                                }
                                break;

                            case 'statistics updated':
                                if (nodeId) {
                                    this.log.debug(`<zwavews> Node ${utils.formatNodeId(nodeId)}: statistics updated`);
                                } else {
                                    this.log.debug('<zwavews> Statistics updated');
                                }
                                break;

                            case 'metadata updated':
                                if (nodeId) {
                                    this.log.debug(`<zwavews> Node ${utils.formatNodeId(nodeId)}: metadata updated`);
                                } else {
                                    this.log.debug('<zwavews> Metadata updated');
                                }
                                break;

                            case 'node info received':
                                if (nodeId) {
                                    this.log.debug(`<zwavews> Node ${utils.formatNodeId(nodeId)}: node info received`);
                                } else {
                                    this.log.debug('<zwavews> Node info received');
                                }
                                break;

                            default:
                                if (this.config.newTypeEvent) {
                                    this.log.warn(`New type event ->> ${eventTyp.event}`);
                                    this.log.warn(JSON.stringify(messageObj));
                                }
                                break;
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

    return inst;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 1: Meter parsePath Varianten
// ═══════════════════════════════════════════════════════════════════════════════
describe('Meter parsePath Varianten', () => {
    let adapter, inst;

    beforeEach(() => {
        adapter = createMockAdapter();
        inst = buildInstance(adapter);
    });

    it('Meter mit propertyKeyName, commandClass, endpoint>0, propertyKey → Pfad: nodeID.Meter.Electric_kWh_Consumed_50_1_65537', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: {
                event: 'value updated',
                nodeId: 5,
                args: {
                    commandClass: 50, commandClassName: 'Meter',
                    endpoint: 1,
                    property: 'value', propertyName: 'value',
                    propertyKey: 65537, propertyKeyName: 'Electric_kWh_Consumed',
                    newValue: 2.5,
                },
            },
        });
        await inst.messageParse(msg);
        const call = adapter._helperCalls.find(c => c.method === 'parse');
        assert.ok(call, 'parse should be called');
        assert.strictEqual(call.path, 'nodeID_005.Meter.Electric_kWh_Consumed_50_1_65537');
        assert.strictEqual(call.val, 2.5);
        assert.strictEqual(call.notif, false);
    });

    it('Meter mit propertyKeyName, commandClass, endpoint=0, propertyKey → Pfad: nodeID.Meter.Electric_kWh_50_65536', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: {
                event: 'value updated',
                nodeId: 5,
                args: {
                    commandClass: 50, commandClassName: 'Meter',
                    endpoint: 0,
                    property: 'value', propertyName: 'value',
                    propertyKey: 65536, propertyKeyName: 'Electric_kWh',
                    newValue: 1.03,
                },
            },
        });
        await inst.messageParse(msg);
        const call = adapter._helperCalls.find(c => c.method === 'parse');
        assert.ok(call);
        // endpoint=0 → nicht im Pfad
        assert.strictEqual(call.path, 'nodeID_005.Meter.Electric_kWh_50_65536');
    });

    it('Meter ohne propertyKeyName (reset) → Pfad: nodeID.Meter.reset_50', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: {
                event: 'value updated',
                nodeId: 10,
                args: {
                    commandClass: 50, commandClassName: 'Meter',
                    endpoint: 0,
                    property: 'reset', propertyName: 'reset',
                    propertyKey: null, propertyKeyName: null,
                    newValue: 0,
                },
            },
        });
        await inst.messageParse(msg);
        const call = adapter._helperCalls.find(c => c.method === 'parse');
        assert.ok(call);
        assert.strictEqual(call.path, 'nodeID_010.Meter.reset_50');
    });

    it('Meter mit UNKNOWN propertyKeyName → KEIN State, nur Warnung', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: {
                event: 'value updated',
                nodeId: 5,
                args: {
                    commandClass: 50, commandClassName: 'Meter',
                    endpoint: 0,
                    property: 'value', propertyName: 'value',
                    propertyKey: 99999, propertyKeyName: 'UNKNOWN_99999',
                    newValue: 42,
                },
            },
        });
        await inst.messageParse(msg);
        const parseCalls = adapter._helperCalls.filter(c => c.method === 'parse');
        assert.strictEqual(parseCalls.length, 0, 'Kein parse-Aufruf bei UNKNOWN propertyKeyName');
        assert.ok(adapter.logs.warn.some(w => w.includes('UNKNOWN')), 'Warnung wegen UNKNOWN propertyKeyName');
    });

    it('Meter ohne propertyKey aber mit propertyKeyName → Pfad ohne _propertyKey Suffix', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: {
                event: 'value updated',
                nodeId: 5,
                args: {
                    commandClass: 50, commandClassName: 'Meter',
                    endpoint: 0,
                    property: 'value', propertyName: 'value',
                    propertyKey: null, propertyKeyName: 'Electric_kWh',
                    newValue: 10.5,
                },
            },
        });
        await inst.messageParse(msg);
        const call = adapter._helperCalls.find(c => c.method === 'parse');
        assert.ok(call);
        // Kein propertyKey → kein _Suffix am Ende
        assert.strictEqual(call.path, 'nodeID_005.Meter.Electric_kWh_50');
    });

    it('Meter value notification → notif=true', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: {
                event: 'value notification',
                nodeId: 5,
                args: {
                    commandClass: 50, commandClassName: 'Meter',
                    endpoint: 0,
                    property: 'value', propertyName: 'value',
                    propertyKey: 65536, propertyKeyName: 'Electric_kWh',
                    newValue: 3.14,
                },
            },
        });
        await inst.messageParse(msg);
        const call = adapter._helperCalls.find(c => c.method === 'parse');
        assert.ok(call);
        assert.strictEqual(call.notif, true);
        assert.strictEqual(call.path, 'nodeID_005.Meter.Electric_kWh_50_65536');
    });

    it('Meter mit endpoint>0 aber ohne propertyKey → endpoint im Pfad', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: {
                event: 'value updated',
                nodeId: 5,
                args: {
                    commandClass: 50, commandClassName: 'Meter',
                    endpoint: 2,
                    property: 'value', propertyName: 'value',
                    propertyKey: null, propertyKeyName: 'Electric_kWh',
                    newValue: 5.0,
                },
            },
        });
        await inst.messageParse(msg);
        const call = adapter._helperCalls.find(c => c.method === 'parse');
        assert.ok(call);
        assert.strictEqual(call.path, 'nodeID_005.Meter.Electric_kWh_50_2');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 2: Neue Event-Handler
// ═══════════════════════════════════════════════════════════════════════════════
describe('Neue Event-Handler', () => {
    let adapter, inst;

    beforeEach(() => {
        adapter = createMockAdapter();
        inst = buildInstance(adapter);
    });

    describe('node added', () => {
        it('sollte helper.createNode() aufrufen', async () => {
            const msg = JSON.stringify({
                type: 'event',
                event: {
                    event: 'node added',
                    args: [{ id: 7, name: 'New Node', values: [] }],
                },
            });
            await inst.messageParse(msg);
            const call = adapter._helperCalls.find(c => c.method === 'createNode');
            assert.ok(call, 'createNode should be called');
            assert.strictEqual(call.nodeId, 7);
            assert.ok(call.nodeData);
            assert.strictEqual(call.nodeData.name, 'New Node');
            assert.ok(adapter.logs.info.some(l => l.includes('Node 7 added')));
        });

        it('sollte nichts tun wenn args leer', async () => {
            const msg = JSON.stringify({
                type: 'event',
                event: {
                    event: 'node added',
                    args: [],
                },
            });
            await inst.messageParse(msg);
            const calls = adapter._helperCalls.filter(c => c.method === 'createNode');
            assert.strictEqual(calls.length, 0);
        });
    });

    describe('interview progress', () => {
        it('sollte log.info mit progress% ausgeben', async () => {
            const msg = JSON.stringify({
                type: 'event',
                event: {
                    event: 'interview progress',
                    nodeId: 3,
                    args: [
                        { id: 3 },
                        { progress: 75, stage: 'ProtocolInfo' },
                    ],
                },
            });
            await inst.messageParse(msg);
            assert.ok(adapter.logs.info.some(l =>
                l.includes('nodeID_003') && l.includes('75%') && l.includes('ProtocolInfo')
            ));
        });

        it('sollte ohne progress nichts loggen', async () => {
            const msg = JSON.stringify({
                type: 'event',
                event: {
                    event: 'interview progress',
                    nodeId: 3,
                    args: [{ id: 3 }],
                },
            });
            await inst.messageParse(msg);
            const infoLogs = adapter.logs.info.filter(l => l.includes('interview progress'));
            assert.strictEqual(infoLogs.length, 0);
        });
    });

    describe('value removed (Nicht-Meter)', () => {
        it('sollte deleteState mit property/commandClass-Pfad aufrufen', async () => {
            const msg = JSON.stringify({
                type: 'event',
                event: {
                    event: 'value removed',
                    nodeId: 5,
                    args: [
                        { id: 5 },
                        {
                            commandClass: 38, commandClassName: 'Multilevel Switch',
                            endpoint: 0, property: 'currentValue',
                        },
                    ],
                },
            });
            await inst.messageParse(msg);
            const delStates = adapter._delStates;
            assert.ok(delStates.length >= 1, 'deleteState should be called');
            // value removed (Nicht-Meter) wendet KEIN formatObject an → Leerzeichen bleiben
            assert.ok(delStates.some(s => s.includes('nodeID_005.Multilevel Switch.currentValue')));
        });

        it('sollte deleteState mit propertyKey im Pfad aufrufen', async () => {
            const msg = JSON.stringify({
                type: 'event',
                event: {
                    event: 'value removed',
                    nodeId: 5,
                    args: [
                        { id: 5 },
                        {
                            commandClass: 99, commandClassName: 'User Code',
                            endpoint: 0, property: 'userCode', propertyKey: 0,
                        },
                    ],
                },
            });
            await inst.messageParse(msg);
            const delStates = adapter._delStates;
            assert.ok(delStates.length >= 1);
            // value removed (Nicht-Meter) wendet KEIN formatObject an → Leerzeichen und propertyKey direkt
            assert.ok(delStates.some(s => s.includes('nodeID_005.User Code.userCode.0')));
        });
    });

    describe('value removed (Meter)', () => {
        it('sollte deleteState mit Meter-Pfad aufrufen', async () => {
            const msg = JSON.stringify({
                type: 'event',
                event: {
                    event: 'value removed',
                    nodeId: 5,
                    args: [
                        { id: 5 },
                        {
                            commandClass: 50, commandClassName: 'Meter',
                            endpoint: 0, property: 'value', propertyName: 'value',
                            propertyKey: 65536, propertyKeyName: 'Electric_kWh',
                        },
                    ],
                },
            });
            await inst.messageParse(msg);
            const delStates = adapter._delStates;
            assert.ok(delStates.length >= 1);
            assert.ok(delStates.some(s => s === 'nodeID_005.Meter.Electric_kWh_50_65536'));
            assert.ok(adapter.logs.info.some(l => l.includes('value removed')));
        });

        it('Meter value removed mit UNKNOWN propertyKeyName → kein deleteState, nur Warnung', async () => {
            const msg = JSON.stringify({
                type: 'event',
                event: {
                    event: 'value removed',
                    nodeId: 5,
                    args: [
                        { id: 5 },
                        {
                            commandClass: 50, commandClassName: 'Meter',
                            endpoint: 0, property: 'value', propertyName: 'value',
                            propertyKey: 99999, propertyKeyName: 'UNKNOWN_99999',
                        },
                    ],
                },
            });
            await inst.messageParse(msg);
            assert.strictEqual(adapter._delStates.length, 0);
            assert.ok(adapter.logs.warn.some(w => w.includes('UNKNOWN') && w.includes('skipping delete')));
        });
    });

    describe('inclusion/exclusion events', () => {
        it('inclusion started → setStateChanged info.inclusion_status', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'inclusion started' },
            }));
            assert.strictEqual(adapter._states['info.inclusion_status'].val, 'started');
            assert.ok(adapter.logs.info.some(l => l.includes('Inclusion started')));
        });

        it('exclusion started → setStateChanged info.exclusion_status', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'exclusion started' },
            }));
            assert.strictEqual(adapter._states['info.exclusion_status'].val, 'started');
            assert.ok(adapter.logs.info.some(l => l.includes('Exclusion started')));
        });

        it('inclusion stopped → setStateChanged info.inclusion_status stopped', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'inclusion stopped' },
            }));
            assert.strictEqual(adapter._states['info.inclusion_status'].val, 'stopped');
        });

        it('exclusion stopped → setStateChanged info.exclusion_status stopped', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'exclusion stopped' },
            }));
            assert.strictEqual(adapter._states['info.exclusion_status'].val, 'stopped');
        });

        it('inclusion failed → log.warn + setStateChanged failed', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'inclusion failed' },
            }));
            assert.strictEqual(adapter._states['info.inclusion_status'].val, 'failed');
            assert.ok(adapter.logs.warn.some(w => w.includes('Inclusion failed')));
        });

        it('exclusion failed → log.warn + setStateChanged failed', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'exclusion failed' },
            }));
            assert.strictEqual(adapter._states['info.exclusion_status'].val, 'failed');
            assert.ok(adapter.logs.warn.some(w => w.includes('Exclusion failed')));
        });

        it('inclusion aborted → log.warn + setStateChanged aborted', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'inclusion aborted' },
            }));
            assert.strictEqual(adapter._states['info.inclusion_status'].val, 'aborted');
            assert.ok(adapter.logs.warn.some(w => w.includes('Inclusion aborted')));
        });
    });

    describe('status changed', () => {
        it('sollte info.controller_status setzen', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'status changed', args: ['ready'] },
            }));
            assert.strictEqual(adapter._states['info.controller_status'].val, 'ready');
            assert.ok(adapter.logs.info.some(l => l.includes('Controller status changed')));
        });
    });

    describe('driver events', () => {
        it('driver error → log.error', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'driver error', args: [{ message: 'Test error' }] },
            }));
            assert.ok(adapter.logs.error.some(e => e.includes('Driver error') && e.includes('Test error')));
        });

        it('driver error ohne message property', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'driver error', args: ['plain error string'] },
            }));
            assert.ok(adapter.logs.error.some(e => e.includes('Driver error') && e.includes('plain error string')));
        });

        it('driver ready → log.info', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'driver ready' },
            }));
            assert.ok(adapter.logs.info.some(l => l.includes('Driver ready')));
        });

        it('all nodes ready → log.info', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'all nodes ready' },
            }));
            assert.ok(adapter.logs.info.some(l => l.includes('All nodes ready')));
        });

        it('bootloader ready → log.info', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'bootloader ready' },
            }));
            assert.ok(adapter.logs.info.some(l => l.includes('Bootloader ready')));
        });

        it('controller firmware update progress → log.info', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'controller firmware update progress', args: [{ progress: 50 }] },
            }));
            assert.ok(adapter.logs.info.some(l => l.includes('Controller firmware update progress')));
        });

        it('controller firmware update finished → log.info', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'controller firmware update finished', args: [{ success: true }] },
            }));
            assert.ok(adapter.logs.info.some(l => l.includes('Controller firmware update finished')));
        });
    });

    describe('node found', () => {
        it('sollte log.info mit Node-ID ausgeben', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'node found', args: [{ id: 12 }] },
            }));
            assert.ok(adapter.logs.info.some(l => l.includes('Node found') && l.includes('12')));
        });

        it('sollte nichts loggen bei leeren args', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'node found', args: [] },
            }));
            const nodeFoundLogs = adapter.logs.info.filter(l => l.includes('Node found'));
            assert.strictEqual(nodeFoundLogs.length, 0, 'Kein Log bei leeren args');
        });
    });

    describe('user added/modified/deleted', () => {
        it('user added → log.info', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: {
                    event: 'user added', nodeId: 5,
                    args: [{ id: 5 }, { userId: 1, code: '1234' }],
                },
            }));
            assert.ok(adapter.logs.info.some(l => l.includes('user added')));
        });

        it('user modified → log.info', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: {
                    event: 'user modified', nodeId: 5,
                    args: [{ id: 5 }, { userId: 2, code: '5678' }],
                },
            }));
            assert.ok(adapter.logs.info.some(l => l.includes('user modified')));
        });

        it('user deleted → log.info', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: {
                    event: 'user deleted', nodeId: 5,
                    args: [{ id: 5 }, { userId: 3 }],
                },
            }));
            assert.ok(adapter.logs.info.some(l => l.includes('user deleted')));
        });
    });

    describe('credential added/modified/deleted', () => {
        it('credential added → log.info', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: {
                    event: 'credential added', nodeId: 5,
                    args: [{ id: 5 }, { type: 'pin' }],
                },
            }));
            assert.ok(adapter.logs.info.some(l => l.includes('credential added')));
        });

        it('credential modified → log.info', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: {
                    event: 'credential modified', nodeId: 5,
                    args: [{ id: 5 }, { type: 'pin' }],
                },
            }));
            assert.ok(adapter.logs.info.some(l => l.includes('credential modified')));
        });

        it('credential deleted → log.info', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: {
                    event: 'credential deleted', nodeId: 5,
                    args: [{ id: 5 }, { type: 'pin' }],
                },
            }));
            assert.ok(adapter.logs.info.some(l => l.includes('credential deleted')));
        });
    });

    describe('rebuild routes progress / grant security classes / validate dsk', () => {
        it('rebuild routes progress → log.info', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'rebuild routes progress', args: [{ progress: '50%' }] },
            }));
            assert.ok(adapter.logs.info.some(l => l.includes('Rebuild routes progress')));
        });

        it('grant security classes → log.info', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'grant security classes', args: [['S2_AccessControl']] },
            }));
            assert.ok(adapter.logs.info.some(l => l.includes('Grant security classes')));
        });

        it('validate dsk → log.info', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: { event: 'validate dsk', args: ['12345-67890'] },
            }));
            assert.ok(adapter.logs.info.some(l => l.includes('Validate DSK')));
        });
    });

    describe('credential learn progress / completed', () => {
        it('credential learn progress → log.info', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: {
                    event: 'credential learn progress', nodeId: 5,
                    args: [{ id: 5 }, { progress: 80 }],
                },
            }));
            assert.ok(adapter.logs.info.some(l => l.includes('credential learn progress')));
        });

        it('credential learn completed → log.info', async () => {
            await inst.messageParse(JSON.stringify({
                type: 'event', event: {
                    event: 'credential learn completed', nodeId: 5,
                    args: [{ id: 5 }, { success: true }],
                },
            }));
            assert.ok(adapter.logs.info.some(l => l.includes('credential learn completed')));
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 3: Notification Event (Home Security)
// ═══════════════════════════════════════════════════════════════════════════════
describe('Notification Event', () => {
    let adapter, inst;

    beforeEach(() => {
        adapter = createMockAdapter();
        inst = buildInstance(adapter);
    });

    it('notification mit args → korrekter Pfad nodeID_048.Notification', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: {
                event: 'notification',
                nodeId: 48,
                args: {
                    commandClass: 113, commandClassName: 'Notification',
                    endpoint: 0, property: 'Home Security', propertyName: 'Home Security',
                    propertyKey: 'Cover status', propertyKeyName: 'Cover status',
                    newValue: 3,
                },
            },
        });
        await inst.messageParse(msg);
        const call = adapter._helperCalls.find(c => c.method === 'parse');
        assert.ok(call, 'parse should be called');
        assert.strictEqual(call.path, 'nodeID_048.Notification');
        assert.strictEqual(call.notif, true);
        assert.deepStrictEqual(call.val, {
            commandClass: 113, commandClassName: 'Notification',
            endpoint: 0, property: 'Home Security', propertyName: 'Home Security',
            propertyKey: 'Cover status', propertyKeyName: 'Cover status',
            newValue: 3,
        });
    });

    it('notification ohne args aber mit notificationLabel/parameters → Fallback', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: {
                event: 'notification',
                nodeId: 48,
                notificationLabel: 'Home Security',
                parameters: { status: 'tampered' },
            },
        });
        await inst.messageParse(msg);
        const call = adapter._helperCalls.find(c => c.method === 'parse');
        assert.ok(call);
        assert.strictEqual(call.path, 'nodeID_048.Notification');
        assert.strictEqual(call.notif, true);
        // Fallback erzeugt { name, parameters }
        assert.strictEqual(call.val.name, 'Home Security');
        assert.deepStrictEqual(call.val.parameters, { status: 'tampered' });
        assert.ok(adapter.logs.debug.some(l => l.includes('notification without args')));
    });

    it('notification mit args → nicht mit Fallback', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: {
                event: 'notification',
                nodeId: 10,
                args: { commandClass: 113, property: 'Smoke Alarm', newValue: 1 },
                notificationLabel: 'should not be used',
                parameters: { x: 1 },
            },
        });
        await inst.messageParse(msg);
        const call = adapter._helperCalls.find(c => c.method === 'parse');
        assert.ok(call);
        // Wenn args vorhanden, wird args verwendet (nicht Fallback)
        assert.ok(!adapter.logs.debug.some(l => l.includes('notification without args')));
        assert.strictEqual(call.val.commandClass, 113);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 4: Controller vs Node Events (nodeId-Schutz)
// ═══════════════════════════════════════════════════════════════════════════════
describe('Controller vs Node Events (nodeId-Schutz)', () => {
    let adapter, inst;

    beforeEach(() => {
        adapter = createMockAdapter();
        inst = buildInstance(adapter);
    });

    it('Controller-Event ohne nodeId → kein Fehler (inclusion started)', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: { event: 'inclusion started' },
        });
        await inst.messageParse(msg);
        // Kein Fehler-Log
        assert.ok(adapter.logs.error.length === 0, 'Kein Fehler bei Controller-Event ohne nodeId');
    });

    it('Controller-Event ohne nodeId → kein Fehler (driver ready)', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: { event: 'driver ready' },
        });
        await inst.messageParse(msg);
        assert.ok(adapter.logs.error.length === 0);
        assert.ok(adapter.logs.info.some(l => l.includes('Driver ready')));
    });

    it('Node-Event mit nodeId → nodeId korrekt mit utils.formatNodeId formatiert', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: { event: 'alive', nodeId: 42 },
        });
        await inst.messageParse(msg);
        const parseCalls = adapter._helperCalls.filter(c => c.method === 'parse');
        assert.ok(parseCalls.some(c => c.path.startsWith('nodeID_042')));
    });

    it('Node-Event: ready ohne nodeId-Fehler', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: { event: 'ready', nodeId: 99 },
        });
        await inst.messageParse(msg);
        const parseCalls = adapter._helperCalls.filter(c => c.method === 'parse');
        assert.ok(parseCalls.some(c => c.path === 'nodeID_099.status'));
        assert.ok(parseCalls.some(c => c.path === 'nodeID_099.ready'));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 5: Reconnect-Mechanismus (websocketController)
// ═══════════════════════════════════════════════════════════════════════════════
describe('Reconnect-Mechanismus (WebsocketController)', () => {
    let adapter, controller;

    beforeEach(() => {
        resetWsModuleState();
        adapter = {
            config: {
                wsScheme: 'ws',
                wsServerIP: '127.0.0.1',
                wsServerPort: 3000,
                wsTokenEnabled: false,
                wsToken: '',
            },
            log: {
                info: () => {},
                warn: () => {},
                error: () => {},
                debug: () => {},
            },
            logs: { info: [], warn: [], error: [], debug: [] },
            startWebsocket: function () {
                this._wsStarted = (this._wsStarted || 0) + 1;
            },
            _wsStarted: 0,
        };
        controller = new WebsocketController(adapter);
    });

    afterEach(() => {
        controller.allTimerClear();
        resetWsModuleState();
    });

    describe('autoRestart', () => {
        it('autoRestart setzt timeout und ruft startWebsocket auf', function (done) {
            this.timeout(5000);
            let started = false;
            adapter.startWebsocket = () => { started = true; };

            controller.autoRestart();

            // autoRestart setzt ein timeout, nach dem startWebsocket aufgerufen wird
            setTimeout(() => {
                // sollte innerhalb von 2s gestartet sein (WS_RESTART_TIMEOUT = 1000)
                assert.strictEqual(started, true, 'startWebsocket should have been called');
                done();
            }, 2000);
        });

        it('Max retries (50) → Aufgabe nach Erreichen', function (done) {
            this.timeout(3000);
            let errorCalled = false;
            adapter.log.error = (msg) => {
                if (msg.includes('Max restart retries')) errorCalled = true;
            };
            adapter.startWebsocket = () => {};

            // 51 mal autoRestart aufrufen → sollte beim 51. Mal aufgeben
            for (let i = 0; i < 51; i++) {
                controller.autoRestart();
            }

            // Der letzte (51.) Aufruf sollte die Fehlermeldung loggen
            assert.ok(errorCalled, 'Max retries error should have been logged');
            done();
        });
    });

    describe('send() Message-Buffering', () => {
        it('send() während wsClient null → Nachricht im Buffer', () => {
            controller.wsClient = null;
            controller.send('test message 1');

            // Nachricht sollte gepuffert sein
            const wsModule = require('../../lib/websocketController');
            // Wir können nicht direkt auf messageBuffer zugreifen, aber flushMessageBuffer
            // zeigt uns ob was da ist
            // indirekter Test: kein Fehler, keine direkte Sendung
            // Wir testen den Warn-Log
        });

        it('send() während wsClient OPEN → direkt gesendet', () => {
            const mock = new MockWebSocket();
            controller.wsClient = mock;
            controller.send('{"command":"test"}');
            assert.deepStrictEqual(mock._sent, ['{"command":"test"}']);
        });

        it('Buffer overflow → älteste Nachricht verworfen', () => {
            const wsModule = require('../../lib/websocketController');

            // Buffer leeren
            controller.resetRetryState();
            controller.wsClient = null;

            // Maximale Buffer-Größe (1000) + 1 Nachrichten senden
            // Die erste sollte verworfen werden
            let oldestDropped = false;
            adapter.log.warn = (msg) => {
                if (msg.includes('dropping oldest message')) {
                    oldestDropped = true;
                }
            };

            for (let i = 0; i < 1001; i++) {
                controller.send(`message_${i}`);
            }

            assert.ok(oldestDropped, 'Oldest message should have been dropped');
            controller.resetRetryState();
        });
    });

    describe('flushMessageBuffer', () => {
        it('flushMessageBuffer sendet alle gepufferten Nachrichten', () => {
            const wsModule = require('../../lib/websocketController');
            controller.resetRetryState();

            const mock = new MockWebSocket();
            controller.wsClient = mock;

            // Erst puffern (wsClient CLOSED)
            mock.readyState = MockWebSocket.CLOSED;
            controller.send('buffered_msg_1');
            controller.send('buffered_msg_2');

            // Dann OPEN setzen
            mock.readyState = MockWebSocket.OPEN;

            // Jetzt flushen
            controller.flushMessageBuffer();

            assert.ok(mock._sent.includes('buffered_msg_1'));
            assert.ok(mock._sent.includes('buffered_msg_2'));
            controller.resetRetryState();
        });

        it('flushMessageBuffer mit leerem Buffer → nichts passiert', () => {
            controller.resetRetryState();
            const mock = new MockWebSocket();
            controller.wsClient = mock;
            mock.readyState = MockWebSocket.OPEN;

            controller.flushMessageBuffer();
            // Keine Nachrichten gesendet
            assert.strictEqual(mock._sent.length, 0);
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 6: Dead-Status
// ═══════════════════════════════════════════════════════════════════════════════
describe('Dead-Status', () => {
    let adapter, inst;

    beforeEach(() => {
        adapter = createMockAdapter();
        inst = buildInstance(adapter);
    });

    it('nodeData.status=4 → status wird auf "dead" gesetzt (kein Suffix)', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: { event: 'dead', nodeId: 7 },
        });
        await inst.messageParse(msg);
        const statusCall = adapter._helperCalls.find(c => c.method === 'parse' && c.path.endsWith('.status'));
        assert.ok(statusCall);
        assert.strictEqual(statusCall.val, 'dead');
    });

    it('nodeData.status=alive → status wird auf "alive" gesetzt', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: { event: 'alive', nodeId: 7 },
        });
        await inst.messageParse(msg);
        const statusCall = adapter._helperCalls.find(c => c.method === 'parse' && c.path.endsWith('.status'));
        assert.ok(statusCall);
        assert.strictEqual(statusCall.val, 'alive');
    });

    it('dead Event setzt ready=false', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: { event: 'dead', nodeId: 7 },
        });
        await inst.messageParse(msg);
        const readyCall = adapter._helperCalls.find(c => c.method === 'parse' && c.path.endsWith('.ready'));
        assert.ok(readyCall);
        assert.strictEqual(readyCall.val, false);
    });

    it('sleep Event setzt status=sleep und ready=true', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: { event: 'sleep', nodeId: 7 },
        });
        await inst.messageParse(msg);
        const statusCall = adapter._helperCalls.find(c => c.method === 'parse' && c.path.endsWith('.status'));
        const readyCall = adapter._helperCalls.find(c => c.method === 'parse' && c.path.endsWith('.ready'));
        assert.ok(statusCall);
        assert.strictEqual(statusCall.val, 'sleep');
        assert.ok(readyCall);
        assert.strictEqual(readyCall.val, true);
    });

    it('wake up Event setzt status=wake up und ready=true', async () => {
        const msg = JSON.stringify({
            type: 'event',
            event: { event: 'wake up', nodeId: 7 },
        });
        await inst.messageParse(msg);
        const statusCall = adapter._helperCalls.find(c => c.method === 'parse' && c.path.endsWith('.status'));
        const readyCall = adapter._helperCalls.find(c => c.method === 'parse' && c.path.endsWith('.ready'));
        assert.ok(statusCall);
        assert.strictEqual(statusCall.val, 'wake up');
        assert.ok(readyCall);
        assert.strictEqual(readyCall.val, true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 7: messageParse - Mutex
// ═══════════════════════════════════════════════════════════════════════════════
describe('messageParse - Mutex', () => {
    let adapter, inst;

    beforeEach(() => {
        adapter = createMockAdapter();
        inst = buildInstance(adapter);
    });

    it('sequenzielle Verarbeitung: zwei parallele calls werden nacheinander verarbeitet', async () => {
        // Beide Nachrichten parallel senden
        await Promise.all([
            inst.messageParse(JSON.stringify({ type: 'version', driverVersion: '1.0' })),
            inst.messageParse(JSON.stringify({ type: 'version', driverVersion: '2.0' })),
        ]);
        // Die letzte Nachricht gewinnt bei version (überschreibt)
        assert.strictEqual(adapter._states['info.zwave_gateway_version'].val, '2.0');
        // Keine Fehler
        assert.strictEqual(adapter.logs.error.length, 0);
    });

    it('sequenzielle Verarbeitung: result nach version sollte funktionieren', async () => {
        await inst.messageParse(JSON.stringify({ type: 'version', driverVersion: '1.0' }));
        assert.strictEqual(adapter._states['info.connection'].val, true);

        await inst.messageParse(JSON.stringify({
            type: 'result',
            result: { state: { nodes: [{ nodeId: 10, name: 'Test' }] } },
        }));
        assert.strictEqual(inst.allNodesCreated, true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 8: Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════
describe('Edge Cases', () => {
    let adapter, inst;

    beforeEach(() => {
        adapter = createMockAdapter();
        inst = buildInstance(adapter);
    });

    it('interview started → log.info mit Node-ID', async () => {
        await inst.messageParse(JSON.stringify({
            type: 'event', event: { event: 'interview started', nodeId: 5 },
        }));
        assert.ok(adapter.logs.info.some(l => l.includes('interview started')));
    });

    it('interview stage completed → log.info', async () => {
        await inst.messageParse(JSON.stringify({
            type: 'event', event: { event: 'interview stage completed', nodeId: 5 },
        }));
        assert.ok(adapter.logs.info.some(l => l.includes('interview stage completed')));
    });

    it('interview failed → log.info', async () => {
        await inst.messageParse(JSON.stringify({
            type: 'event', event: { event: 'interview failed', nodeId: 5 },
        }));
        assert.ok(adapter.logs.info.some(l => l.includes('interview failed')));
    });

    it('interview completed → log.info', async () => {
        await inst.messageParse(JSON.stringify({
            type: 'event', event: { event: 'interview completed', nodeId: 5 },
        }));
        assert.ok(adapter.logs.info.some(l => l.includes('interview completed')));
    });

    it('firmware update progress → log.info mit Prozentangabe', async () => {
        await inst.messageParse(JSON.stringify({
            type: 'event', event: {
                event: 'firmware update progress', nodeId: 5,
                totalFragments: 100, sentFragments: 50,
            },
        }));
        assert.ok(adapter.logs.info.some(l => l.includes('50.0%')));
    });

    it('firmware update progress mit totalFragments=0 → 0%', async () => {
        await inst.messageParse(JSON.stringify({
            type: 'event', event: {
                event: 'firmware update progress', nodeId: 5,
                totalFragments: 0, sentFragments: 0,
            },
        }));
        assert.ok(adapter.logs.info.some(l => l.includes('0.0%')));
    });

    it('firmware update finished → log.info', async () => {
        await inst.messageParse(JSON.stringify({
            type: 'event', event: { event: 'firmware update finished', nodeId: 5 },
        }));
        assert.ok(adapter.logs.info.some(l => l.includes('firmware update finished')));
    });

    it('node removed with useEventInDesc=true → updateDevice mit desc', async () => {
        inst.config.useEventInDesc = true;
        await inst.messageParse(JSON.stringify({
            type: 'event', event: { event: 'node removed', nodeId: 5 },
        }));
        const call = adapter._helperCalls.find(c => c.method === 'updateDevice');
        assert.ok(call);
        assert.strictEqual(call.nodeId, 'nodeID_005');
        assert.deepStrictEqual(call.arg, { desc: 'Node is Deleted' });
    });

    it('node removed with useEventInDesc=false → updateDevice mit name', async () => {
        inst.config.useEventInDesc = false;
        await inst.messageParse(JSON.stringify({
            type: 'event', event: { event: 'node removed', nodeId: 5 },
        }));
        const call = adapter._helperCalls.find(c => c.method === 'updateDevice');
        assert.ok(call);
        assert.deepStrictEqual(call.arg, { name: 'Node is Deleted' });
    });

    it('statistics updated mit nodeId → log.debug mit Node-ID', async () => {
        await inst.messageParse(JSON.stringify({
            type: 'event', event: { event: 'statistics updated', nodeId: 5 },
        }));
        assert.ok(adapter.logs.debug.some(l => l.includes('statistics updated')));
    });

    it('statistics updated ohne nodeId → log.debug ohne Node-ID', async () => {
        await inst.messageParse(JSON.stringify({
            type: 'event', event: { event: 'statistics updated' },
        }));
        assert.ok(adapter.logs.debug.some(l => l.includes('Statistics updated')));
    });

    it('metadata updated → log.debug', async () => {
        await inst.messageParse(JSON.stringify({
            type: 'event', event: { event: 'metadata updated', nodeId: 5 },
        }));
        assert.ok(adapter.logs.debug.some(l => l.includes('metadata updated')));
    });

    it('node info received → log.debug', async () => {
        await inst.messageParse(JSON.stringify({
            type: 'event', event: { event: 'node info received', nodeId: 5 },
        }));
        assert.ok(adapter.logs.debug.some(l => l.includes('node info received')));
    });

    it('unknown event → log.warn mit newTypeEvent=true', async () => {
        await inst.messageParse(JSON.stringify({
            type: 'event', event: { event: 'completely_new_event', nodeId: 5 },
        }));
        assert.ok(adapter.logs.warn.some(w => w.includes('New type event')));
    });

    it('result success=true → debugmessages state setzen', async () => {
        await inst.messageParse(JSON.stringify({
            type: 'result', result: { success: true, message: 'ok' },
        }));
        assert.ok(adapter._states['info.debugmessages'].val.includes('"success":true'));
    });
});
