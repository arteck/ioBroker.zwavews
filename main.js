'use strict';

const core = require('@iobroker/adapter-core');
const utils = require('./lib/utils');
const constant = require('./lib/constants');
const dmZwave = require('./lib/devicemgmt.js');

const {adapterInfo} = require('./lib/messages');
const {StatesController} = require('./lib/statesController');
const {WebsocketController} = require('./lib/websocketController');
const {Helper} = require('./lib/helper');

class zwavews extends core.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'zwavews',
        });

        // Instanz-State statt Modul-globale Variablen
        this.deviceCache = {};
        this.websocketController = null;
        this.statesController = null;
        this.helper = null;
        this.messageParseMutex = Promise.resolve();
        this.parseOptions = {write: false};
        this.startListening = false;
        this.allNodesCreated = false;
        this.nodeCache = {};

        this.on('ready', () => {
            this.onReady().catch((e) => this.log.error(`onReady error: ${e}`));
        });
        this.on('stateChange', (id, state) => {
            this.onStateChange(id, state).catch((e) => this.log.error(`onStateChange error: ${e}`));
        });
        this.on('message', (obj) => {
            this.onMessage(obj).catch((e) => this.log.error(`onMessage error: ${e}`));
        });
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

        if (this.config.connectionType === 'ws') {
            if (!this.config.wsServerIP) {
                this.log.warn('Please configure the Websocket connection!');
                return;
            }

            this.startWebsocket();
        }
    }


    async onMessage(obj) {
        if (!obj || !obj.command) {
            return;
        }

        if (obj.command === 'reInterviewNode') {
            try {
                const nodeId = obj.message?.nodeId;
                if (!nodeId) {
                    this.log.error('reInterviewNode: No nodeId provided');
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, {error: 'No nodeId provided'}, obj.callback);
                    }
                    return;
                }
                this.log.info(`reInterviewNode: Re-interviewing node ${nodeId}...`);

                const message = {
                    messageId: utils.genMessageId(),
                    command: 'node.refresh_info',
                    nodeId,
                };

                const sendMessageAllowed = await this.getStateAsync('info.sendMessageAllowed');
                if (sendMessageAllowed && sendMessageAllowed.val === true) {
                    if (this.websocketController) {
                        this.websocketController.send(JSON.stringify(message));
                        this.log.info(`reInterviewNode: Re-interview command sent for node ${nodeId}`);
                        if (obj.callback) {
                            this.sendTo(obj.from, obj.command, {result: `Re-interview started for node ${nodeId}`}, obj.callback);
                        }
                    } else {
                        this.log.error('reInterviewNode: WebSocket controller not available');
                        if (obj.callback) {
                            this.sendTo(obj.from, obj.command, {error: 'WebSocket controller not available'}, obj.callback);
                        }
                    }
                } else {
                    this.log.warn('reInterviewNode: Send message is not allowed (info.sendMessageAllowed is false)');
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, {error: 'Send message is not allowed'}, obj.callback);
                    }
                }
            } catch (e) {
                this.log.error(`reInterviewNode: Error: ${e.message}`);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, {error: e.message}, obj.callback);
                }
            }
        }

        if (obj.command === 'deleteNullStates') {
            try {
                const allStates = await this.getStatesAsync('*');
                const allObjects = await this.getAdapterObjectsAsync();
                const deletedList = [];
                const errorList = [];
                let delObj = false;
                for (const [id, state] of Object.entries(allStates)) {
                    delObj = false;
                    if (state) {
                        if (state.val === null) {
                            delObj = true;
                        }
                        if (state.val === '') {
                            delObj = true;
                        }

                        if (id.includes('zwavews.0.info')) {
                            delObj = false;
                        }

                        if (delObj) {
                            const objNow = allObjects[id];
                            try {
                                if (!objNow.common.write) {
                                    await this.delObjectAsync(id);
                                    deletedList.push(id);
                                }
                            } catch (e) {
                                errorList.push(id);
                            }
                        }
                    }
                }
                if (deletedList.length > 0) {
                    this.log.warn(`deleteNullStates: deleted ${deletedList.length} state(s):`);
                    for (const deletedId of deletedList) {
                        this.log.warn(`  - ${deletedId}`);
                    }
                }
                if (errorList.length > 0) {
                    this.log.warn(`deleteNullStates: failed to delete ${errorList.length} state(s):`);
                    for (const errId of errorList) {
                        this.log.warn(`  - ${errId}`);
                    }
                }
                const msg = `Deleted ${deletedList.length} null state(s)${errorList.length > 0 ? `, ${errorList.length} error(s)` : ''}.`;
                this.log.info(`deleteNullStates: ${msg}`);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, {result: msg}, obj.callback);
                }
            } catch (e) {
                this.log.error(`deleteNullStates: Fehler: ${e.message}`);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, {error: e.message}, obj.callback);
                }
            }
        }
    }

    startWebsocket() {
        this.websocketController = new WebsocketController(this);
        const wsClient = this.websocketController.initWsClient();

        if (!wsClient) {
            // initWsClient hat autoRestart() bereits getriggert – kein manueller Eingriff nötig.
            this.log.warn('<zwavews> initWsClient failed — auto-restart already scheduled.');
            return;
        }

        wsClient.on('open', () => {
            this.log.info('Connect to zwave-js-ui over websocket connection.');
            this.startListening = true;
            this.websocketController.send(JSON.stringify({
                command: 'initialize',
                messageId: 'api-schema',
                schemaVersion: constant.api_schema,
            }));
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
            Object.keys(this.deviceCache).forEach(k => delete this.deviceCache[k]);
            Object.keys(this.nodeCache).forEach(k => delete this.nodeCache[k]);
            this.log.info('Websocket connection closed. Attempting to reconnect...');
        });
    }

    async messageParse(message) {
        let release;
        const lock = new Promise((resolve) => (release = resolve));
        const prev = this.messageParseMutex;
        this.messageParseMutex = lock;
        await prev;

        try {
            const eventMessage = await this.getStateAsync('info.eventMessage');
            let messageObj = JSON.parse(message);

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
                            if (messageObj.messageId !== 'api-schema') {
                                this.log.warn('<zwavews> Invalid result.state structure received, skipping.');
                            } else {
                                this.log.info(`Set API-Schema to ${constant.api_schema}`);
                            }
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
                            await this.helper.createNode(nodeId, nodeData);
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
                        if (eventMessage?.val) {
                            this.log.error(`--->>> fromZ2W ->  manual event Message added`);
                            messageObj.event = JSON.parse(eventMessage.val);
                            messageObj.event = messageObj.event.event;
                        }

                        const eventTyp = messageObj.event;
                        const nodeId = eventTyp.nodeId; // undefined für Controller/Driver-Events
                        // Zentral berechnet – nodeId kann bei Controller/Driver-Events undefined sein
                        const formattedNodeId = nodeId != null ? utils.formatNodeId(nodeId) : null;

                        switch (eventTyp.event) {
                            case 'value updated':
                            case 'value added':
                            case 'value notification': {
                                const nodeArg = eventTyp.args;

                                if (debugDevicesState?.val && String(debugDevicesState.val).includes(formattedNodeId)) {
                                    this.log.warn(`--->>> fromZ2W_RAW_3-> ${JSON.stringify(eventTyp)}`);
                                }

                                const {path: parsePath, skip, updateDevice} =
                                    utils.buildValueEventPath(formattedNodeId, nodeArg, constant);

                                if (skip) {
                                    // z.B. Meter mit UNKNOWN propertyKeyName
                                    this.log.warn(`<zwavews> Node ${nodeId}: Unknown propertyKeyName "${nodeArg.propertyKeyName}" for ${nodeArg.commandClassName}.${nodeArg.propertyName}`);
                                    break;
                                }

                                if (updateDevice) {
                                    // CC 119 name → zusätzlich Gerätenamen aktualisieren
                                    await this.helper.updateDevice(formattedNodeId, nodeArg);
                                }

                                this.log.debug(`${parsePath} ->> ${nodeArg.newValue}`);

                                const change = eventTyp.event === 'value notification';
                                await this.helper.parse(parsePath, nodeArg.newValue, this.parseOptions, change);

                                break;
                            }

                            case 'notification': {
                                const parsePath = `${formattedNodeId}.Notification`;

                                let notifMessage = {};

                                if (eventTyp?.args) {
                                    notifMessage = eventTyp.args;
                                } else {
                                    // Fallback: ws-server sendet immer args, dies dient als Sicherheitsnetz
                                    this.log.debug(`<zwavews> notification without args, using fallback for node ${formattedNodeId}`);
                                    notifMessage = {
                                        name: eventTyp.notificationLabel,
                                        parameters: eventTyp.parameters
                                    };
                                }

                                await this.helper.parse(parsePath, notifMessage, this.parseOptions, true);

                                if (debugDevicesState?.val && String(debugDevicesState.val).includes(formattedNodeId)) {
                                    this.log.warn(`--->>> fromZ2W_RAW_notification-> ${JSON.stringify(eventTyp)}`);
                                }
                                break;
                            }

                            case 'firmware update progress': {
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
                                this.log.info(`${formattedNodeId} --> ${eventTyp.event}`);
                                break;
                            }

                            case 'ready':
                            case 'sleep':
                            case 'wake up':
                            case 'alive':
                            case 'dead': {
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
                                if (this.config.useEventInDesc) {
                                    await this.helper.updateDevice(formattedNodeId, {desc: 'Node is Deleted'}, false);
                                } else {
                                    await this.helper.updateDevice(formattedNodeId, {name: 'Node is Deleted'}, true);
                                }
                                this.log.error(`Delete ${formattedNodeId}`);
                                break;
                            }

                            case 'interview started':
                            case 'interview stage completed':
                            case 'interview failed':
                            case 'interview completed':
                                this.log.info(`${formattedNodeId} --> ${eventTyp.event}`);
                                break;

                            // ── Neue Event-Handler ──

                            case 'node added':
                                // Controller-Event (kein nodeId) – args: [zwaveNode]
                                if (eventTyp.args && eventTyp.args.length > 0) {
                                    const newNode = eventTyp.args[0];
                                    const addedNodeId = newNode?.id;
                                    if (addedNodeId) {
                                        await this.helper.createNode(addedNodeId, newNode);
                                        this.log.info(`<zwavews> Node ${addedNodeId} added`);
                                    }
                                }
                                break;

                            case 'interview progress':
                                // Node-Event – args: [zwaveNode, {progress, stage}]
                                if (eventTyp.args && eventTyp.args.length >= 2) {
                                    const progress = eventTyp.args[1];
                                    if (progress && typeof progress.progress === 'number') {
                                        this.log.info(`<zwavews> Node ${formattedNodeId} interview progress: ${progress.progress}% (${progress.stage || 'unknown'})`);
                                    }
                                }
                                break;

                            case 'value removed':
                                if (eventTyp.args && eventTyp.args.length >= 2) {
                                    const valueArgs = eventTyp.args[1];
                                    if (valueArgs) {
                                        const commandClassName = valueArgs.commandClassName || valueArgs.commandClass;

                                        if (commandClassName?.toLowerCase() === 'meter') {
                                            // Meter: propertyKeyName_commandClass_endpoint_propertyKey
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
                                // Controller-Event (kein nodeId)
                                if (eventTyp.args && eventTyp.args.length > 0) {
                                    const foundNode = eventTyp.args[0];
                                    this.log.info(`<zwavews> Node found: ${foundNode?.id || 'unknown'}`);
                                }
                                break;

                            case 'user added':
                            case 'user modified':
                            case 'user deleted':
                            case 'credential added':
                            case 'credential modified':
                            case 'credential deleted':
                                // Node-Events – args: [zwaveNode, user|credential]
                                if (eventTyp.args && eventTyp.args.length >= 2) {
                                    const payload = eventTyp.args[1];
                                    this.log.info(`<zwavews> Node ${formattedNodeId} ${eventTyp.event}: ${JSON.stringify(payload)}`);
                                }
                                break;

                            case 'inclusion started':
                                // Controller-Event (kein nodeId)
                                this.log.info('<zwavews> Inclusion started');
                                this.setStateChanged('info.inclusion_status', 'started', true);
                                break;

                            case 'exclusion started':
                                // Controller-Event (kein nodeId)
                                this.log.info('<zwavews> Exclusion started');
                                this.setStateChanged('info.exclusion_status', 'started', true);
                                break;

                            case 'inclusion stopped':
                                // Controller-Event (kein nodeId)
                                this.log.info('<zwavews> Inclusion stopped');
                                this.setStateChanged('info.inclusion_status', 'stopped', true);
                                break;

                            case 'exclusion stopped':
                                // Controller-Event (kein nodeId)
                                this.log.info('<zwavews> Exclusion stopped');
                                this.setStateChanged('info.exclusion_status', 'stopped', true);
                                break;

                            case 'inclusion failed':
                                // Controller-Event (kein nodeId)
                                this.log.warn('<zwavews> Inclusion failed');
                                this.setStateChanged('info.inclusion_status', 'failed', true);
                                break;

                            case 'exclusion failed':
                                // Controller-Event (kein nodeId)
                                this.log.warn('<zwavews> Exclusion failed');
                                this.setStateChanged('info.exclusion_status', 'failed', true);
                                break;

                            case 'status changed':
                                // Controller-Event (kein nodeId) – args: [statusString]
                                if (eventTyp.args && eventTyp.args.length > 0) {
                                    const status = eventTyp.args[0];
                                    this.log.info(`<zwavews> Controller status changed: ${status}`);
                                    this.setStateChanged('info.controller_status', status, true);
                                }
                                break;

                            case 'driver error':
                                // Driver-Event (kein nodeId) – args: [error]
                                if (eventTyp.args && eventTyp.args.length > 0) {
                                    const error = eventTyp.args[0];
                                    this.log.error(`<zwavews> Driver error: ${error?.message || error}`);
                                }
                                break;

                            case 'driver ready':
                                // Driver-Event (kein nodeId)
                                this.log.info('<zwavews> Driver ready');
                                break;

                            case 'all nodes ready':
                                // Driver-Event (kein nodeId)
                                this.log.info('<zwavews> All nodes ready');
                                break;

                            case 'bootloader ready':
                                // Driver-Event (kein nodeId)
                                this.log.info('<zwavews> Bootloader ready - firmware update mode');
                                break;

                            case 'controller firmware update progress':
                                // Driver-Event (kein nodeId)
                                if (eventTyp.args && eventTyp.args.length > 0) {
                                    const fwProgress = eventTyp.args[0];
                                    this.log.info(`<zwavews> Controller firmware update progress: ${JSON.stringify(fwProgress)}`);
                                }
                                break;

                            case 'controller firmware update finished':
                                // Driver-Event (kein nodeId)
                                if (eventTyp.args && eventTyp.args.length > 0) {
                                    const fwResult = eventTyp.args[0];
                                    this.log.info(`<zwavews> Controller firmware update finished: ${JSON.stringify(fwResult)}`);
                                }
                                break;

                            case 'rebuild routes progress':
                                // Controller-Event (kein nodeId)
                                if (eventTyp.args && eventTyp.args.length > 0) {
                                    const routesProgress = eventTyp.args[0];
                                    this.log.info(`<zwavews> Rebuild routes progress: ${JSON.stringify(routesProgress)}`);
                                }
                                break;

                            case 'grant security classes':
                                // Controller-Event (kein nodeId)
                                if (eventTyp.args && eventTyp.args.length > 0) {
                                    const requested = eventTyp.args[0];
                                    this.log.info(`<zwavews> Grant security classes requested: ${JSON.stringify(requested)}`);
                                }
                                break;

                            case 'validate dsk':
                                // Controller-Event (kein nodeId)
                                if (eventTyp.args && eventTyp.args.length > 0) {
                                    const dsk = eventTyp.args[0];
                                    this.log.info(`<zwavews> Validate DSK: ${dsk}`);
                                }
                                break;

                            case 'inclusion aborted':
                                // Controller-Event (kein nodeId)
                                this.log.warn('<zwavews> Inclusion aborted');
                                this.setStateChanged('info.inclusion_status', 'aborted', true);
                                break;

                            case 'credential learn progress':
                                // Node-Event (Schema 48)
                                if (eventTyp.args && eventTyp.args.length >= 2) {
                                    const learnProgress = eventTyp.args[1];
                                    this.log.info(`<zwavews> Node ${formattedNodeId} credential learn progress: ${JSON.stringify(learnProgress)}`);
                                }
                                break;

                            case 'credential learn completed':
                                // Node-Event (Schema 48)
                                if (eventTyp.args && eventTyp.args.length >= 2) {
                                    const learnResult = eventTyp.args[1];
                                    this.log.info(`<zwavews> Node ${formattedNodeId} credential learn completed: ${JSON.stringify(learnResult)}`);
                                }
                                break;

                            case 'statistics updated':
                                // Node-Event (hat nodeId) – Controller-Event (kein nodeId) auch möglich
                                if (nodeId) {
                                    this.log.debug(`<zwavews> Node ${formattedNodeId}: statistics updated`);
                                } else {
                                    this.log.debug('<zwavews> Statistics updated');
                                }
                                break;

                            case 'metadata updated':
                                if (nodeId) {
                                    this.log.debug(`<zwavews> Node ${formattedNodeId}: metadata updated`);
                                } else {
                                    this.log.debug('<zwavews> Metadata updated');
                                }
                                break;

                            case 'node info received':
                                if (nodeId) {
                                    this.log.debug(`<zwavews> Node ${formattedNodeId}: node info received`);
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
            this.log.error(err);
            this.log.error(`<zwavews> error message -->> ${message}`);
        } finally {
            release();
        }
    }

    async onUnload(callback) {
        try {
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
            this.setStateChanged('info.zwave_gateway_status', false, true);
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

            if (id.endsWith('.reInterview')) {
                if (state.val === true) {
                    const m = id.match(/nodeID_0*(\d+)/i);
                    if (!m) {
                        this.log.warn(`<zwavews> Could not extract nodeId from reInterview state id: ${id}`);
                        return;
                    }
                    const nodeId = Number(m[1]);

                    const message = {
                        messageId: utils.genMessageId(),
                        command: 'node.refresh_info',
                        nodeId,
                    };

                    const sendMessageAllowed = await this.getStateAsync('info.sendMessageAllowed');

                    if (sendMessageAllowed && sendMessageAllowed.val === true) {
                        if (this.websocketController) {
                            this.websocketController.send(JSON.stringify(message));
                            this.log.info(`Re-interview triggered for node ${nodeId} via state button`);
                        } else {
                            this.log.warn('<zwavews> websocketController not initialised, cannot send re-interview.');
                        }
                    }

                    this.setStateChanged('info.debugmessages', JSON.stringify(message), true);
                }

                // Always reset the button to false
                await this.setStateChangedAsync(id, false, true);
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
                    messageId: utils.genMessageId(),
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
