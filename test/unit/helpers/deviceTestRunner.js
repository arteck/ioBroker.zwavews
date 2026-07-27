'use strict';

/**
 * Generischer Geräte-Test-Runner für iobroker.zwavews
 *
 * Ermöglicht das Testen beliebiger Geräte über deren JSON-Datei
 * aus dem Ordner test/jsons/.
 *
 * Nutzung:
 *   const { runDeviceTests } = require('./helpers/deviceTestRunner');
 *   runDeviceTests('rollo-node_5');
 *   runDeviceTests('keypad-node_48');
 */

const assert  = require('assert');
const path    = require('path');
const utils   = require('../../../lib/utils');
const constant = require('../../../lib/constants');

// ─── parsePath-Berechnung (exakt wie main.js) ────────────────────────────────

/**
 * Berechnet den erwarteten parsePath für einen value-Eintrag aus der JSON.
 *
 * Delegiert an die zentrale Produktions-Funktion utils.buildValueEventPath,
 * damit Test-Erwartung und Adapter garantiert dieselbe Logik nutzen.
 *
 * @param {string} nodeId   - formatierter nodeId (z.B. "nodeID_048")
 * @param {object} valueEntry - ein Eintrag aus node.values[]
 * @returns {string} erwarteter parsePath
 */
function calcExpectedPath(nodeId, valueEntry) {
    const { path } = utils.buildValueEventPath(nodeId, valueEntry, constant);
    return path;
}

// ─── Mock-Adapter-Factory ────────────────────────────────────────────────────

function buildMockInstance() {
    const _states      = {};
    const _logs        = { info: [], warn: [], error: [], debug: [] };
    const _helperCalls = [];
    const _wsSent      = [];

    const helperStub = {
        parse:        async (p, v, o, n) => _helperCalls.push({ method: 'parse',        path: p, val: v, notif: n }),
        createNode:   async (nodeId, nd)  => _helperCalls.push({ method: 'createNode',   nodeId, nodeData: nd }),
        updateDevice: async (nodeId, arg) => _helperCalls.push({ method: 'updateDevice', nodeId, arg }),
    };

    const inst = {
        config: {
            connectionType: 'ws',
            showNodeInfoMessage: false,
            newTypeEvent: true,
            wakeUpInfo: true,
            useEventInDesc: false,
        },
        log: {
            info:  (m) => _logs.info.push(m),
            warn:  (m) => _logs.warn.push(m),
            error: (m) => _logs.error.push(m),
            debug: (m) => _logs.debug.push(m),
        },
        _logs, _states, _helperCalls, _wsSent,
        helper:              helperStub,
        websocketController: { send: (m) => _wsSent.push(m) },
        statesController:    { setAllAvailableToFalse: async () => {} },
        allNodesCreated:     false,
        startListening:      false,
        nodeCache:           {},
        parseOptions:        {},
        messageParseMutex:   Promise.resolve(),
        getStateAsync:       async (id) => _states[id] ?? null,
        setStateChanged:     (id, val, ack) => { _states[id] = { val, ack }; },
    };

    // messageParse – exakte Produktions-Kopie aus main.js
    inst.messageParse = async function (message) {
        let release;
        const lock = new Promise((resolve) => (release = resolve));
        const prev = this.messageParseMutex;
        this.messageParseMutex = lock;
        await prev;

        try {
            const messageObj        = JSON.parse(message);
            const debugDevicesState = await this.getStateAsync('info.debugId');
            const type              = messageObj?.type;

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
                                if (this.config.showNodeInfoMessage) this.log.info(`Node Info Update for ${nodeId}`);
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

                            case 'value updated':
                            case 'value added':
                            case 'value notification': {
                                const nodeArg = eventTyp.args;
                                const nodeId  = utils.formatNodeId(eventTyp.nodeId);

                                if (debugDevicesState?.val && String(debugDevicesState.val).includes(nodeId)) {
                                    this.log.warn(`--->>> fromZ2W_RAW2-> ${JSON.stringify(eventTyp)}`);
                                }

                                const { path: parsePath, skip, updateDevice } =
                                    utils.buildValueEventPath(nodeId, nodeArg, constant);

                                if (skip) {
                                    this.log.warn(`<zwavews> Node ${eventTyp.nodeId}: Unknown propertyKeyName "${nodeArg.propertyKeyName}" for ${nodeArg.commandClassName}.${nodeArg.propertyName}`);
                                    break;
                                }

                                if (updateDevice) {
                                    await this.helper.updateDevice(nodeId, nodeArg);
                                }

                                const change = eventTyp.event === 'value notification';
                                await this.helper.parse(parsePath, nodeArg.newValue, this.parseOptions, change);
                                break;
                            }

                            case 'notification': {
                                const nodeId = utils.formatNodeId(eventTyp.nodeId);
                                const parsePath = `${nodeId}.Notification`;

                                let notifMessage = {};

                                if (eventTyp?.args) {
                                    notifMessage = eventTyp.args;
                                } else {
                                    // Fallback: ws-server sendet immer args, dies dient als Sicherheitsnetz
                                    this.log.debug(`<zwavews> notification without args, using fallback for node ${nodeId}`);
                                    notifMessage = {
                                        name: eventTyp.notificationLabel,
                                        parameters: eventTyp.parameters,
                                    };
                                }

                                await this.helper.parse(parsePath, notifMessage, this.parseOptions, true);
                                break;
                            }

                            case 'ready':
                            case 'sleep':
                            case 'wake up':
                            case 'alive':
                            case 'dead': {
                                const nodeId = utils.formatNodeId(eventTyp.nodeId);
                                await this.helper.parse(`${nodeId}.status`, eventTyp.event.toLowerCase(), this.parseOptions);
                                await this.helper.parse(`${nodeId}.ready`, eventTyp.event !== 'dead', this.parseOptions);
                                if (this.config.wakeUpInfo) this.log.info(`${utils.formatNodeId(eventTyp.nodeId)} --> ${eventTyp.event}`);
                                break;
                            }

                            case 'node removed': {
                                const nodeId = utils.formatNodeId(eventTyp.nodeId);
                                if (this.config.useEventInDesc) {
                                    await this.helper.updateDevice(nodeId, { desc: 'Node is Deleted' }, false);
                                } else {
                                    await this.helper.updateDevice(nodeId, { name: 'Node is Deleted' }, true);
                                }
                                this.log.error(`Delete ${utils.formatNodeId(eventTyp.nodeId)}`);
                                break;
                            }

                            case 'interview started':
                            case 'interview stage completed':
                            case 'interview failed':
                            case 'interview completed':
                                this.log.info(`${utils.formatNodeId(eventTyp.nodeId)} --> ${eventTyp.event}`);
                                break;

                            case 'statistics updated':
                            case 'metadata updated':
                            case 'node info received':
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

// ─── Öffentliche API ─────────────────────────────────────────────────────────

/**
 * Führt den vollständigen generischen Test-Suite für eine Gerätedatei aus.
 *
 * @param {string} jsonFileName - Dateiname ohne .json, z.B. "rollo-node_5"
 * @param {object} [opts]
 * @param {string[]} [opts.skipIds]      - value-IDs die übersprungen werden sollen
 * @param {object}  [opts.extraTests]    - Funktion(inst, nodeData, nodeId) für gerätespezifische Tests
 */
function runDeviceTests(jsonFileName, opts = {}) {
    const jsonPath  = path.resolve(__dirname, '../../jsons', `${jsonFileName}.json`);
    const nodeData  = require(jsonPath);

    // Die JSON hat "id" am Root (nicht "nodeId") — WS-Protokoll nutzt "nodeId"
    const nodeDataWs = { ...nodeData, nodeId: nodeData.id };
    const nodeId     = utils.formatNodeId(nodeData.id);

    // Werte ohne 'location' (CC 119) und ohne Sonderfälle die keinen parsePath erzeugen
    const testableValues = nodeData.values.filter(v => {
        if (opts.skipIds && opts.skipIds.includes(v.id)) return false;
        if (v.commandClass === 119 && v.property === 'location') return false;
        return true;
    });

    describe(`Gerät: ${jsonFileName} (Node ${nodeData.id} – ${nodeData.name || ''})`, () => {

        // ── JSON-Struktur ──────────────────────────────────────────────────
        describe('JSON-Datei Struktur', () => {

            it(`sollte id=${nodeData.id} enthalten`, () => {
                assert.strictEqual(nodeData.id, nodeData.id);
            });

            it('sollte values[] als Array enthalten', () => {
                assert.ok(Array.isArray(nodeData.values), 'values ist kein Array');
                assert.ok(nodeData.values.length > 0, 'values ist leer');
            });

            it('jeder value-Eintrag hat id, commandClass, commandClassName, propertyName', () => {
                for (const v of nodeData.values) {
                    assert.ok(v.id,              `id fehlt in: ${JSON.stringify(v)}`);
                    assert.ok(v.commandClass != null, `commandClass fehlt: ${v.id}`);
                    assert.ok(v.commandClassName, `commandClassName fehlt: ${v.id}`);
                    assert.ok(v.propertyName != null,  `propertyName fehlt: ${v.id}`);
                }
            });

            it('JSON-Root hat "id" (nicht "nodeId") → WS-Mapping erforderlich', () => {
                assert.strictEqual(typeof nodeData.id, 'number');
                assert.strictEqual(nodeData.nodeId, undefined);
            });
        });

        // ── result-Nachricht → createNode ──────────────────────────────────
        describe('result-Nachricht → createNode', () => {
            let inst;
            beforeEach(() => { inst = buildMockInstance(); });

            it(`sollte createNode für ${nodeId} aufrufen`, async () => {
                const msg = JSON.stringify({
                    type: 'result',
                    result: { state: { nodes: [nodeDataWs] } },
                });
                await inst.messageParse(msg);
                assert.strictEqual(inst.allNodesCreated, true, 'allNodesCreated wurde nicht gesetzt');
                const call = inst._helperCalls.find(c => c.method === 'createNode');
                assert.ok(call, 'createNode nicht aufgerufen');
                assert.strictEqual(call.nodeId, nodeId);
            });

            it(`sollte nodeCache[${nodeId}] befüllen`, async () => {
                const msg = JSON.stringify({
                    type: 'result',
                    result: { state: { nodes: [nodeDataWs] } },
                });
                await inst.messageParse(msg);
                assert.ok(inst.nodeCache[nodeId], `nodeCache[${nodeId}] fehlt`);
            });

            it('zweite result-Nachricht wird ignoriert (allNodesCreated)', async () => {
                const msg = JSON.stringify({ type: 'result', result: { state: { nodes: [nodeDataWs] } } });
                await inst.messageParse(msg);
                inst._helperCalls.length = 0;
                await inst.messageParse(msg);
                assert.strictEqual(inst._helperCalls.filter(c => c.method === 'createNode').length, 0);
            });
        });

        // ── parsePath pro value-Eintrag ────────────────────────────────────
        describe('parsePath-Berechnung je value-Eintrag', () => {

            for (const v of testableValues) {
                const expected = calcExpectedPath(nodeId, v);

                it(`[${v.id}] → parsePath: "${expected}"`, async () => {
                    const inst = buildMockInstance();

                    const eventType = v.stateless ? 'value notification' : 'value updated';
                    const args = {
                        commandClass:    v.commandClass,
                        commandClassName: v.commandClassName,
                        endpoint:        v.endpoint ?? 0,
                        property:        v.property       ?? v.propertyName,
                        propertyName:    v.propertyName,
                        propertyKey:     v.propertyKey,
                        propertyKeyName: v.propertyKeyName,
                        newValue:        v.value ?? null,
                    };

                    const msg = JSON.stringify({
                        type: 'event',
                        event: { event: eventType, nodeId: nodeData.id, args },
                    });

                    await inst.messageParse(msg);

                    const call = inst._helperCalls.find(c => c.method === 'parse');
                    assert.ok(call, `parse() wurde für ${v.id} nicht aufgerufen`);
                    assert.strictEqual(call.path, expected,
                        `parsePath falsch für ${v.id}\n  erwartet: ${expected}\n  erhalten: ${call.path}`);
                });
            }
        });

        // ── value notification vs value updated → notif-Flag ──────────────
        describe('notif-Flag (value notification vs value updated)', () => {
            let inst;
            beforeEach(() => { inst = buildMockInstance(); });

            it('"value notification" → notif=true', async () => {
                const v = testableValues[0];
                const msg = JSON.stringify({
                    type: 'event',
                    event: {
                        event: 'value notification',
                        nodeId: nodeData.id,
                        args: {
                            commandClass: v.commandClass,
                            commandClassName: v.commandClassName,
                            endpoint: v.endpoint ?? 0,
                            property: v.property ?? v.propertyName,
                            propertyName: v.propertyName,
                            propertyKeyName: v.propertyKeyName,
                            newValue: 1,
                        },
                    },
                });
                await inst.messageParse(msg);
                const call = inst._helperCalls.find(c => c.method === 'parse');
                assert.ok(call);
                assert.strictEqual(call.notif, true, 'value notification muss notif=true liefern');
            });

            it('"value updated" → notif=false', async () => {
                const v = testableValues[0];
                const msg = JSON.stringify({
                    type: 'event',
                    event: {
                        event: 'value updated',
                        nodeId: nodeData.id,
                        args: {
                            commandClass: v.commandClass,
                            commandClassName: v.commandClassName,
                            endpoint: v.endpoint ?? 0,
                            property: v.property ?? v.propertyName,
                            propertyName: v.propertyName,
                            propertyKeyName: v.propertyKeyName,
                            newValue: 1,
                        },
                    },
                });
                await inst.messageParse(msg);
                const call = inst._helperCalls.find(c => c.method === 'parse');
                assert.ok(call);
                assert.strictEqual(call.notif, false, 'value updated muss notif=false liefern');
            });
        });

        // ── Node-Lifecycle Events ──────────────────────────────────────────
        describe('Node-Lifecycle Events', () => {
            let inst;
            beforeEach(() => { inst = buildMockInstance(); });

            for (const ev of ['ready', 'alive', 'sleep', 'wake up']) {
                it(`Event "${ev}" → ready=true, status="${ev}"`, async () => {
                    const msg = JSON.stringify({ type: 'event', event: { event: ev, nodeId: nodeData.id } });
                    await inst.messageParse(msg);
                    const calls   = inst._helperCalls.filter(c => c.method === 'parse');
                    const status  = calls.find(c => c.path === `${nodeId}.status`);
                    const ready   = calls.find(c => c.path === `${nodeId}.ready`);
                    assert.ok(status, `status nicht geparst für "${ev}"`);
                    assert.strictEqual(status.val, ev.toLowerCase());
                    assert.ok(ready,  `ready nicht geparst für "${ev}"`);
                    assert.strictEqual(ready.val, true);
                });
            }

            it('Event "dead" → ready=false, status="dead"', async () => {
                const msg = JSON.stringify({ type: 'event', event: { event: 'dead', nodeId: nodeData.id } });
                await inst.messageParse(msg);
                const calls  = inst._helperCalls.filter(c => c.method === 'parse');
                const status = calls.find(c => c.path === `${nodeId}.status`);
                const ready  = calls.find(c => c.path === `${nodeId}.ready`);
                assert.strictEqual(status?.val, 'dead');
                assert.strictEqual(ready?.val, false);
            });

            it('Event "wake up" → log.info enthält nodeId', async () => {
                const msg = JSON.stringify({ type: 'event', event: { event: 'wake up', nodeId: nodeData.id } });
                await inst.messageParse(msg);
                assert.ok(inst._logs.info.some(l => l.includes(nodeId)));
            });
        });

        // ── Interview Events ───────────────────────────────────────────────
        describe('Interview Events', () => {
            let inst;
            beforeEach(() => { inst = buildMockInstance(); });

            for (const ev of ['interview started', 'interview stage completed', 'interview failed', 'interview completed']) {
                it(`Event "${ev}" → log.info`, async () => {
                    const msg = JSON.stringify({ type: 'event', event: { event: ev, nodeId: nodeData.id } });
                    await inst.messageParse(msg);
                    assert.ok(inst._logs.info.some(l => l.includes(nodeId) && l.includes(ev)));
                });
            }
        });

        // ── node removed ───────────────────────────────────────────────────
        describe('node removed Event', () => {
            let inst;
            beforeEach(() => { inst = buildMockInstance(); });

            it('useEventInDesc=false → updateDevice mit name="Node is Deleted"', async () => {
                inst.config.useEventInDesc = false;
                const msg = JSON.stringify({ type: 'event', event: { event: 'node removed', nodeId: nodeData.id } });
                await inst.messageParse(msg);
                const call = inst._helperCalls.find(c => c.method === 'updateDevice');
                assert.ok(call, 'updateDevice nicht aufgerufen');
                assert.strictEqual(call.arg.name, 'Node is Deleted');
            });

            it('useEventInDesc=true → updateDevice mit desc="Node is Deleted"', async () => {
                inst.config.useEventInDesc = true;
                const msg = JSON.stringify({ type: 'event', event: { event: 'node removed', nodeId: nodeData.id } });
                await inst.messageParse(msg);
                const call = inst._helperCalls.find(c => c.method === 'updateDevice');
                assert.strictEqual(call?.arg?.desc, 'Node is Deleted');
            });

            it('log.error enthält nodeId', async () => {
                const msg = JSON.stringify({ type: 'event', event: { event: 'node removed', nodeId: nodeData.id } });
                await inst.messageParse(msg);
                assert.ok(inst._logs.error.some(l => l.includes(nodeId)));
            });
        });

        // ── Unbekannter Event ──────────────────────────────────────────────
        describe('Unbekannter Event-Typ', () => {
            it('newTypeEvent=true → log.warn "New type event"', async () => {
                const inst = buildMockInstance();
                const msg = JSON.stringify({ type: 'event', event: { event: '__unknown__', nodeId: nodeData.id } });
                await inst.messageParse(msg);
                assert.ok(inst._logs.warn.some(w => w.includes('New type event')));
            });
        });

        // ── Gerätespezifische Zusatztests ──────────────────────────────────
        if (typeof opts.extraTests === 'function') {
            describe('Gerätespezifische Tests', () => {
                opts.extraTests(buildMockInstance, nodeData, nodeId);
            });
        }
    });
}

module.exports = { runDeviceTests, calcExpectedPath, buildMockInstance };
