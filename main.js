'use strict';

const core = require('@iobroker/adapter-core');
const mqtt = require('mqtt');
const utils = require('./lib/utils');
const constant = require('./lib/constants');
const dmZwave = require('./lib/devicemgmt.js');

const {adapterInfo} = require('./lib/messages');
const {StatesController} = require('./lib/statesController');
const {WebsocketController} = require('./lib/websocketController');
const {Helper} = require('./lib/helper');
const {MqttServerController} = require('./lib/mqttServerController');

class zwavews extends core.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'zwavews',
        });

        // Instanz-State statt Modul-globale Variablen
        this.mqttClient = null;
        this.deviceCache = {};
        this.websocketController = null;
        this.mqttServerController = null;
        this.statesController = null;
        this.helper = null;
        this.messageParseMutex = Promise.resolve();
        this.parseOptions = {};
        this.startListening = false;
        this.allNodesCreated = false;
        this.nodeCache = {};

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.statesController = new StatesController(this);

        adapterInfo(this.config, this.log);

        this.setStateChanged('info.connection', false, true);
        await this.statesController.setAllAvailableToFalse();

        this.helper = new Helper(this, this.deviceCache);
        this.deviceManagement = new dmZwave(this);

        if (this.config.wsOnStart) {
            this.setStateChanged('info.sendMessageAllowed', true, true);
        }

        this.setStateChanged('info.debugmessages', '', true);

        // MQTT-Verbindungstypen
        if (['exmqtt', 'intmqtt'].includes(this.config.connectionType)) {
            if (this.config.connectionType === 'exmqtt') {
                if (!this.config.externalMqttServerIP) {
                    this.log.warn('Please configure the External MQTT-Server connection!');
                    return;
                }

                const mqttClientOptions = {
                    clientId: `ioBroker.zwavews_${Math.random().toString(16).slice(2, 8)}`,
                    clean: false,
                    protocolVersion: 4,
                    reconnectPeriod: 5000,
                    connectTimeout: 30000,
                    keepalive: 30,
                    resubscribe: true,
                };

                if (this.config.externalMqttServerCredentials === true) {
                    mqttClientOptions.username = this.config.externalMqttServerUsername;
                    mqttClientOptions.password = this.config.externalMqttServerPassword;
                }

                this.mqttClient = mqtt.connect(
                    `mqtt://${this.config.externalMqttServerIP}:${this.config.externalMqttServerPort}`,
                    mqttClientOptions,
                );
            } else {
                // Interner MQTT-Server
                this.mqttServerController = new MqttServerController(this);
                await this.mqttServerController.createMQTTServer();
                await this.delay(1500);
                this.mqttClient = mqtt.connect(
                    `mqtt://${this.config.mqttServerIPBind}:${this.config.mqttServerPort}`,
                    {
                        clientId: `ioBroker.zwavews_${Math.random().toString(16).slice(2, 8)}`,
                        clean: true,
                        reconnectPeriod: 500,
                    },
                );
            }

            // FIX: subscribe innerhalb des connect-Events, nicht außerhalb
            this.mqttClient.on('connect', () => {
                const connType = this.config.connectionType === 'exmqtt' ? 'external mqtt' : 'internal mqtt';
                this.log.info(`Connect to zwavews over ${connType} connection.`);
                this.setStateChanged('info.connection', true, true);

                this.mqttClient.subscribe(`${this.config.baseTopic}/#`, (err) => {
                    if (err) {
                        this.log.error(`<zwavews> MQTT subscribe error: ${err.message}`);
                    }
                });
            });

            this.mqttClient.on('error', (err) => {
                this.log.error(`<zwavews> MQTT client error: ${err.message}`);
            });

            this.mqttClient.on('offline', () => {
                this.log.warn('<zwavews> MQTT client offline.');
                this.setStateChanged('info.connection', false, true);
            });

            this.mqttClient.on('message', (topic, payload) => {
                const rawPayload = payload.toString();
                let parsedPayload;
                try {
                    parsedPayload = rawPayload === '' ? null : JSON.parse(rawPayload);
                } catch {
                    parsedPayload = rawPayload;
                }
                const newMessage = JSON.stringify({
                    payload: parsedPayload,
                    topic: topic.slice(topic.indexOf('/') + 1),
                });
                this.messageParse(newMessage);
            });
        } else if (this.config.connectionType === 'ws') {
            if (!this.config.wsServerIP) {
                this.log.warn('Please configure the Websocket connection!');
                return;
            }

            if (this.config.dummyMqtt === true) {
                this.mqttServerController = new MqttServerController(this);
                await this.mqttServerController.createDummyMQTTServer();
                this.setStateChanged('info.connection', true, true);
                await this.delay(1500);
            }

            this.startWebsocket();
        }
    }

    startWebsocket() {
        this.websocketController = new WebsocketController(this);
        const wsClient = this.websocketController.initWsClient();

        if (!wsClient) {
            this.log.error('<zwavews> initWsClient returned null — websocket not started.');
            return;
        }

        wsClient.on('open', () => {
            this.log.info('Connect to zwave-js-ui over websocket connection.');
            this.startListening = true;
            this.websocketController.send(JSON.stringify({command: 'start_listening'}));
        });

        wsClient.on('message', (message) => {
            this.messageParse(message);
        });

        wsClient.on('close', async () => {
            this.setStateChanged('info.connection', false, true);
            await this.statesController.setAllAvailableToFalse();
            this.startListening = false;
            this.allNodesCreated = false;
            this.deviceCache = {};
            this.nodeCache = {};
            this.log.info('Websocket connection closed. Attempting to reconnect...');
        });
    }

    async messageParse(message) {
        // FIX: release mit let deklarieren (war implizite globale Variable)
        let release;
        const lock = new Promise((resolve) => (release = resolve));
        const prev = this.messageParseMutex;
        this.messageParseMutex = lock;
        await prev;

        try {
            const messageObj = JSON.parse(message);
            const debugDevicesState = await this.getStateAsync('info.debugId');

            this.log.debug(`--->>> fromZ2W_RAW_1 -> ${JSON.stringify(messageObj)}`);

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

                        if (this.allNodesCreated) {
                            break;
                        }

                        if (!messageObj.result?.state || !Array.isArray(messageObj.result.state.nodes)) {
                            this.log.warn('<zwavews> Invalid result.state structure received, skipping.');
                            break;
                        }

                        const {nodes: allNodes} = messageObj.result.state;

                        for (const nodeData of allNodes) {
                            const nodeId = utils.formatNodeId(nodeData.nodeId);

                            if (debugDevicesState?.val && String(debugDevicesState.val).includes(nodeId)) {
                                this.log.warn(`--->>> fromZ2W_RAW_2-> ${JSON.stringify(nodeData)}`);
                            }

                            if (!this.nodeCache[nodeId]) {
                                if (this.config.showNodeInfoMessage) {
                                    this.log.info(`Node Info Update for ${nodeId}`);
                                }
                                this.nodeCache[nodeId] = {nodeData};
                            }
                            await this.helper.createNode(nodeId, nodeData, this.parseOptions);
                        }

                        this.allNodesCreated = true;

                        if (this.config.showNodeInfoMessage) {
                            this.log.info('all Nodes are ready');
                        }
                        if (this.startListening) {
                            this.websocketController.send(JSON.stringify({command: 'start_listening'}));
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
                                const nodeId = utils.formatNodeId(eventTyp.nodeId);

                                if (debugDevicesState?.val && String(debugDevicesState.val).includes(nodeId)) {
                                    this.log.warn(`--->>> fromZ2W_RAW_3-> ${JSON.stringify(eventTyp)}`);
                                }

                                let parsePath = `${nodeId}.${nodeArg.commandClassName}.${nodeArg.propertyName
                                    .replace(/[^\p{L}\p{N}\s]/gu, '')
                                    .replace(/\s+/g, ' ')
                                    .trim()}`;

                                if (nodeArg?.propertyKeyName) {
                                    parsePath = `${parsePath}.${nodeArg.propertyKeyName
                                        .replace(/[^\p{L}\p{N}\s]/gu, '')
                                        .replace(/\s+/g, ' ')
                                        .trim()}`;

                                    if (constant.RGB.includes(nodeArg.propertyKeyName)) {
                                        parsePath = utils.replaceLastDot(parsePath);
                                    }
                                }

                                parsePath = utils.deleteLastDot(utils.formatObject(parsePath));

                                if (nodeArg.commandClass === 119) {
                                    switch (nodeArg.property) {
                                        case 'name':
                                            await this.helper.updateDevice(nodeId, nodeArg);
                                            parsePath = `${nodeId}.info.${nodeArg.property}`;
                                            break;
                                        case 'location':
                                            break;
                                        default:
                                            parsePath = `${nodeId}.info.${nodeArg.property}`;
                                            break;
                                    }
                                }

                                this.log.debug(`${parsePath} ->> ${nodeArg.newValue}`);

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

                                break;
                            }

                            case  'notification': {
                                const nodeId = utils.formatNodeId(eventTyp.nodeId);
                                this.log.info(`--->>> fromZ2W_RAW_notification-> ${JSON.stringify(eventTyp)}`);
                                break;
                            }

                            case 'firmware update progress': {
                                const total = Number(eventTyp.totalFragments) || 0;
                                const sent = Number(eventTyp.sentFragments) || 0;
                                const progress = total > 0 ? Math.min(100, Math.max(0, (sent / total) * 100)) : 0;
                                this.log.info(
                                    `Firmware update progress for ${utils.formatNodeId(eventTyp.nodeId)} ->> ` +
                                    `send Fragments ${sent} -- total ${total} (${progress.toFixed(1)}%)`,
                                );
                                break;
                            }

                            case 'firmware update finished': {
                                this.log.info(`${utils.formatNodeId(eventTyp.nodeId)} --> ${eventTyp.event}`);
                                break;
                            }

                            case 'ready':
                            case 'sleep':
                            case 'wake up':
                            case 'alive':
                            case 'dead': {
                                const nodeId = utils.formatNodeId(eventTyp.nodeId);
                                await this.helper.parse(`${nodeId}.status`, eventTyp.event.toLowerCase(), this.parseOptions);

                                if (eventTyp.event === 'dead') {
                                    await this.helper.parse(`${nodeId}.ready`, false, this.parseOptions);
                                } else {
                                    await this.helper.parse(`${nodeId}.ready`, true, this.parseOptions);
                                }

                                if (this.config.wakeUpInfo) {
                                    this.log.info(`${utils.formatNodeId(eventTyp.nodeId)} --> ${eventTyp.event}`);
                                }
                                break;
                            }

                            case 'node removed': {
                                const nodeId = utils.formatNodeId(eventTyp.nodeId);
                                if (this.config.useEventInDesc) {
                                    await this.helper.updateDevice(nodeId, {desc: 'Node is Deleted'}, false);
                                } else {
                                    await this.helper.updateDevice(nodeId, {name: 'Node is Deleted'}, true);
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
            this.log.error(err);
            this.log.error(`<zwavews> error message -->> ${message}`);
        } finally {
            release();
        }
    }

    async onUnload(callback) {
        try {
            if (['exmqtt', 'intmqtt'].includes(this.config.connectionType)) {
                if (this.mqttClient && !this.mqttClient.closed) {
                    try {
                        this.mqttClient.end();
                    } catch (e) {
                        this.log.error(e);
                    }
                }
            }

            if (this.config.connectionType === 'intmqtt' || this.config.dummyMqtt === true) {
                try {
                    if (this.mqttServerController) {
                        this.mqttServerController.closeServer();
                    }
                } catch (e) {
                    this.log.error(e);
                }
            }

            if (this.websocketController) {
                try {
                    await this.websocketController.allTimerClear();
                    this.websocketController.closeConnection();
                } catch (e) {
                    this.log.error(e);
                }
            }

            try {
                if (this.statesController) {
                    await this.statesController.setAllAvailableToFalse();
                }
            } catch (e) {
                this.log.error(e);
            }

            this.setStateChanged('info.connection', false, true);
        } finally {
            callback();
        }
    }

    async onStateChange(id, state) {
        if (!this.allNodesCreated) {
            return;
        }

        if (state && state.ack === false) {
            if (id.endsWith('info.debugId')) {
                this.setStateChanged(id, state.val, true);
                return;
            }

            const obj = await this.getObjectAsync(id);
            if (obj) {
                const nativeObj = obj.native || {};

                const m = id.match(/nodeID_0*(\d+)/i);
                if (!m) {
                    this.log.warn(`<zwavews> Could not extract nodeId from state id: ${id}`);
                    return;
                }
                const nodeId = Number(m[1]);

                const message = {
                    messageId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                    command: 'node.set_value',
                    nodeId,
                    valueId: nativeObj.valueId,
                    value: state.val,
                };

                const sendMessageAllowed = await this.getStateAsync('info.sendMessageAllowed');

                if (sendMessageAllowed && sendMessageAllowed.val === true) {
                    if (this.websocketController) {
                        this.websocketController.send(JSON.stringify(message));
                    } else {
                        this.log.warn('<zwavews> websocketController not initialised, cannot send message.');
                    }
                }

                this.setStateChanged('info.debugmessages', JSON.stringify(message), true);
                this.log.debug(`<zwavews> message onStateChange ${JSON.stringify(message)}`);
            }
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new zwavews(options);
} else {
    new zwavews();
}
