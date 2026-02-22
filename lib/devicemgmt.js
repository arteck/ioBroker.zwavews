'use strict';
const dmUtils = require('@iobroker/dm-utils');
const humanizeDuration = require('humanize-duration');

class dmZwave extends dmUtils.DeviceManagement {
    constructor(adapter) {
        super(adapter);
        this.adapter = adapter;
    }

    async listDevices() {
        const devices = await this.adapter.getDevicesAsync();
        const arrDevices = [];
        for (const i in devices) {
            const status = {};

            const nodeId = this.stripIobPrefix(devices[i]._id);

            const device = this.adapter.nodeCache[nodeId].nodeData;

            if (device.ready) {
                status.connection = device.ready ? 'connected' : 'disconnected';
            }

            //const link_quality = await this.adapter.getStateAsync(`${theDevice._id}.status`);
            //status.rssi = link_quality.val == 'alive' ? '100' : '0';

            const battery = await this.adapter.getStateAsync(`${devices[i]._id}.Battery.level`);
            if (battery) {
                status.battery = battery.val;
            }

            const res = {
                id: nodeId,
                name: device.name || device.label,
                icon: device.userIcon || device.installerIcon,
                manufacturer: device.deviceConfig.manufacturer,
                model: device.deviceConfig.label + ' ' + device.deviceConfig.description,
                status: status,
                hasDetails: true,
                actions: [
                    {
                        id: 'doc',
                        icon: 'lines',
                        description: 'Documentation',
                        handler: async (_id, context) => this.openPDF(context, device),
                    },
                ],
            };


            arrDevices.push(res);
        }

        // nach id sortieren (z.B. nodeID_2 vor nodeID_10)
        arrDevices.sort((a, b) => String(a?.id ?? '').localeCompare(String(b?.id ?? ''), undefined, {
            numeric: true,
            sensitivity: 'base',
        }));

        return arrDevices;
    }

    async openPDF(context, device) {
        const manual = device?.deviceConfig?.metadata?.manual;
        const urls = Array.isArray(manual)
            ? manual
            : (typeof manual === 'string' && manual.trim())
                ? [manual]
                : [];

        const items = {};

        if (!urls.length) {
            items._no_manual = {
                type: 'staticText',
                text: this.adapter.i18nTranslation?.['No documentation link found'] || 'No documentation link found',
                newLine: true,
            };
        } else {
            urls
                .filter(u => typeof u === 'string' && u.trim())
                .forEach((u, idx) => {
                    const href = /^https?:\/\//i.test(u) ? u : `https://${u}`;
                    items[`_manual_${idx}`] = {
                        type: 'staticLink',
                        label: urls.length === 1 ? 'Dokumentation' : `Dokumentation ${idx + 1}`,
                        href,
                        button: true,
                        newLine: true,
                    };
                });
        }

        await context.showForm(
            {
                type: 'panel',
                items,
            },
            {
                title: this.adapter.i18nTranslation?.['DeviceDocumentation'] || 'Device documentation',
            },
        );

        return { refresh: true };
    }

    async getDeviceDetails(id, action, context) {
        this.adapter.log.info('getDeviceDetails');

        const device = this.adapter.nodeCache[id].nodeData;

        if(!device) {
            return {error: 'Device not found'};
        }

        const items = {};

        for (const devInfo in device.deviceClass) {

            const val = device.deviceClass[devInfo];
            const item = {
                ['deviceClass ' + devInfo]: {
                    type: 'staticText',
                    text: `inputCluster ${devInfo} : ${val}`,
                    newLine: true,
                },
            };
            Object.assign(items,item);
        }

        const data = {
            id: device.nodeId,
            schema: {
                type: 'tabs',
                items: {
                    _tab_Start: {
                        type: 'panel',
                        label: 'Main',

                        items: {
                            header_Start: {
                                type: 'header',
                                text: `${device.label} ${device?.deviceClass.basic}`,
                                size: 3,
                            },
                            _link: {
                                label: `Manufacturer: ${device.deviceConfig.manufacturer}`,
                                type: 'staticLink',
                                href: `{device.deviceConfig.filename}`,
                                button: true,
                            },
                            _softwareBuildID: {
                                type: 'staticText',
                                text: `<b>Firmware Version:</b> ${device.firmwareVersion}`,
                                style: {
                                    fontSize: 14
                                }
                            },
                            _pluVersion: {
                                type: 'staticText',
                                text: `<b>Zwave Plus Version :</b> ${device.zwavePlusVersion}`,
                                style: {
                                    fontSize: 14
                                }
                            },

                            _divider2: {
                                type: 'divider',
                                color: 'primary',
                            },
                            _isReady: {
                                type: 'checkbox',
                                label: `is Ready`,
                                checked: device.ready ? 'true' : 'false',
                                disabled: 'true',
                                newLine: true,
                            },
                            _isListening: {
                                type: 'checkbox',
                                label: 'is Listening',
                                help: '',
                                checked: device.isListening ? 'true' : 'false',
                                disabled: 'true',
                            },
                            _isRouting: {
                                type: 'checkbox',
                                label: 'is Routing',
                                help: '',
                                checked: device.isRouting ? 'true' : 'false',
                                disabled: 'true',
                            },
                            _isSecure: {
                                type: 'checkbox',
                                label: 'is Secure',
                                help: '',
                                checked: device.isSecure ? 'true' : 'false',
                                disabled: 'true',
                            },
                            _lastSeen: {
                                type: 'staticText',
                                text: `<b>Max Baud Rate :</b> ${device.maxBaudRate} kBaud/s`,
                            },
                        },
                    },
                    _tab_Details: {
                        type: 'panel',
                        label: 'Details',
                        items,
                    },
                },
            },
        };

        return data;
    }



    async formatDate(time, type) {   //'ISO_8601' | 'ISO_8601_local' | 'epoch' | 'relative'
        if (type === 'ISO_8601') return new Date(time).toISOString();
        else if (type === 'ISO_8601_local') return this.toLocalISOString(new Date(time));
        else if (type === 'epoch') return time;
        else { // relative
            const ago = humanizeDuration(Date.now() - time, {language: 'en', largest: 2, round: true}) + ' ago';
            return ago;
        }
    }

    toLocalISOString(d) {
        const off = d.getTimezoneOffset();
        return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes() - off, d.getSeconds(), d.getMilliseconds()).toISOString();
    }
    // Entfernt den ioBroker-Prefix am Anfang, z.B.
    // "zwavews.0.nodeID_1.info.name" -> "nodeID_1.info.name"
     stripIobPrefix(id) {
        const s = String(id ?? '');
        return s.replace(/^[^.]+\.[^.]+\./, '');
    }

}

module.exports = dmZwave;
