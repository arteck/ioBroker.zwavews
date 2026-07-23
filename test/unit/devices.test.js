'use strict';

/**
 * devices.test.js
 *
 * Generischer Test für alle Geräte-JSON-Dateien in test/jsons/.
 *
 * Um ein neues Gerät zu testen:
 *   1. JSON-Datei in test/jsons/ ablegen (z.B. "thermostat-node_7.json")
 *   2. runDeviceTests('thermostat-node_7') hier eintragen
 *   3. Optional: gerätespezifische Tests über `extraTests` ergänzen
 */

const { runDeviceTests } = require('./helpers/deviceTestRunner');

// ─────────────────────────────────────────────────────────────────────────────
// Rollo Node 5 (Fibaro FGR-222 Roller Shutter)
// ─────────────────────────────────────────────────────────────────────────────
runDeviceTests('rollo-node_5', {
    extraTests: (buildMockInstance, nodeData, nodeId) => {

        it('Multilevel Switch currentValue=98 → parsePath nodeID_005.Multilevel_Switch.currentValue', async () => {
            const inst = buildMockInstance();
            const msg = JSON.stringify({
                type: 'event',
                event: {
                    event: 'value updated',
                    nodeId: nodeData.id,
                    args: {
                        commandClass: 38, commandClassName: 'Multilevel Switch',
                        endpoint: 0, property: 'currentValue', propertyName: 'currentValue',
                        newValue: 98,
                    },
                },
            });
            await inst.messageParse(msg);
            const call = inst._helperCalls.find(c => c.method === 'parse');
            const assert = require('assert');
            assert.strictEqual(call.path, `${nodeId}.Multilevel_Switch.currentValue`);
            assert.strictEqual(call.val, 98);
        });

        it('Meter value kWh → parsePath nodeID_005.Meter.Electric_kWh_50_65536', async () => {
            const inst = buildMockInstance();
            const assert = require('assert');
            const msg = JSON.stringify({
                type: 'event',
                event: {
                    event: 'value updated',
                    nodeId: nodeData.id,
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
            const call = inst._helperCalls.find(c => c.method === 'parse');
            assert.ok(call, 'parse nicht aufgerufen');
            // Meter: nodeId.Meter.propertyKeyName_commandClass_endpoint_propertyKey
            assert.strictEqual(call.path, `${nodeId}.Meter.Electric_kWh_50_65536`);
        });

        it('firmwareVersions bekommt _value-Suffix → nodeID_005.Version.firmwareVersions_value', async () => {
            const inst = buildMockInstance();
            const assert = require('assert');
            const msg = JSON.stringify({
                type: 'event',
                event: {
                    event: 'value updated',
                    nodeId: nodeData.id,
                    args: {
                        commandClass: 134, commandClassName: 'Version',
                        endpoint: 0, property: 'firmwareVersions', propertyName: 'firmwareVersions',
                        newValue: ['25.25'],
                    },
                },
            });
            await inst.messageParse(msg);
            const call = inst._helperCalls.find(c => c.method === 'parse');
            assert.strictEqual(call.path, `${nodeId}.Version.firmwareVersions_value`);
        });

        it('Multilevel Switch Open (boolean) → parsePath nodeID_005.Multilevel_Switch.Open', async () => {
            const inst = buildMockInstance();
            const assert = require('assert');
            const msg = JSON.stringify({
                type: 'event',
                event: {
                    event: 'value updated',
                    nodeId: nodeData.id,
                    args: {
                        commandClass: 38, commandClassName: 'Multilevel Switch',
                        endpoint: 0, property: 'Open', propertyName: 'Open',
                        newValue: true,
                    },
                },
            });
            await inst.messageParse(msg);
            const call = inst._helperCalls.find(c => c.method === 'parse');
            assert.strictEqual(call.path, `${nodeId}.Multilevel_Switch.Open`);
        });

        it('Multilevel Sensor Power=0 → parsePath nodeID_005.Multilevel_Sensor.Power', async () => {
            const inst = buildMockInstance();
            const assert = require('assert');
            const msg = JSON.stringify({
                type: 'event',
                event: {
                    event: 'value updated',
                    nodeId: nodeData.id,
                    args: {
                        commandClass: 49, commandClassName: 'Multilevel Sensor',
                        endpoint: 0, property: 'Power', propertyName: 'Power',
                        newValue: 0,
                    },
                },
            });
            await inst.messageParse(msg);
            const call = inst._helperCalls.find(c => c.method === 'parse');
            assert.strictEqual(call.path, `${nodeId}.Multilevel_Sensor.Power`);
        });
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// Keypad Node 48 (Wintop MINI KEYPAD RFID)
// ─────────────────────────────────────────────────────────────────────────────
runDeviceTests('keypad-node_48', {
    extraTests: (buildMockInstance, nodeData, nodeId) => {
        const assert = require('assert');

        it('value notification userCode slot 0 (entered code) → notif=true', async () => {
            const inst = buildMockInstance();
            const msg = JSON.stringify({
                type: 'event',
                event: {
                    event: 'value notification',
                    nodeId: nodeData.id,
                    args: {
                        commandClass: 99, commandClassName: 'User Code',
                        endpoint: 0, property: 'userCode', propertyName: 'userCode',
                        propertyKey: 0, propertyKeyName: '0',
                        newValue: '121244',
                    },
                },
            });
            await inst.messageParse(msg);
            const call = inst._helperCalls.find(c => c.method === 'parse');
            assert.strictEqual(call.path, `${nodeId}.User_Code.userCode.0`);
            assert.strictEqual(call.notif, true);
        });

        it('Notification Home Security Cover status → parsePath mit Cover_status', async () => {
            const inst = buildMockInstance();
            const msg = JSON.stringify({
                type: 'event',
                event: {
                    event: 'notification',
                    nodeId: nodeData.id,
                    args: {
                        commandClass: 113, commandClassName: 'Notification',
                        endpoint: 0, property: 'Home Security', propertyName: 'Home Security',
                        propertyKey: 'Cover status', propertyKeyName: 'Cover status',
                        newValue: 3,
                    },
                },
            });
            await inst.messageParse(msg);
            const call = inst._helperCalls.find(c => c.method === 'parse');
            assert.strictEqual(call.path, `${nodeId}.Notification.Home_Security.Cover_status`);
        });

        it('Battery level=86 → parsePath nodeID_048.Battery.level', async () => {
            const inst = buildMockInstance();
            const msg = JSON.stringify({
                type: 'event',
                event: {
                    event: 'value updated',
                    nodeId: nodeData.id,
                    args: {
                        commandClass: 128, commandClassName: 'Battery',
                        endpoint: 0, property: 'level', propertyName: 'level',
                        newValue: 86,
                    },
                },
            });
            await inst.messageParse(msg);
            const call = inst._helperCalls.find(c => c.method === 'parse');
            assert.strictEqual(call.path, `${nodeId}.Battery.level`);
            assert.strictEqual(call.val, 86);
        });
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// Neues Gerät hinzufügen? Einfach ergänzen:
//
// runDeviceTests('thermostat-node_7');
//
// Mit gerätespezifischen Zusatztests:
// runDeviceTests('thermostat-node_7', {
//     skipIds: ['7-99-0-someIgnoredValue'],
//     extraTests: (buildMockInstance, nodeData, nodeId) => {
//         it('Thermostat setpoint heat → ...', async () => { ... });
//     },
// });
// ─────────────────────────────────────────────────────────────────────────────
