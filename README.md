<--img src="admin/zwaveWS.png" width="200" />

# Icon kommt

# ioBroker.zwaveWS

[![NPM version](https://img.shields.io/npm/v/iobroker.zwaveWS.svg)](https://www.npmjs.com/package/iobroker.zwaveWS)
[![Downloads](https://img.shields.io/npm/dm/iobroker.zwaveWS.svg)](https://www.npmjs.com/package/iobroker.zwaveWS)
![Number of Installations](https://iobroker.live/badges/zwaveWS-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/zwaveWS-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.zwaveWS.png?downloads=true)](https://nodei.co/npm/iobroker.zwaveWS/)

**Tests:**  
![Test and Release](https://github.com/arteck/ioBroker.zwaveWS/workflows/Test%20and%20Release/badge.svg)
![CodeQL](https://github.com/arteck/ioBroker.zwaveWS/actions/workflows/codeql.yml/badge.svg?branch=main)

## zwaveWS adapter for ioBroker

The `zwaveWS` adapter connects a [`zwave-js-ui`](https://zwave-js.github.io/zwave-js-ui/#/) to ioBroker and creates corresponding data points for devices, values, and statuses. This allows Z-Wave devices to be conveniently used in visualizations, logic, and automations.


## Adapter Documentation

What is required is to install zwave-js-ui and activate WS communication.
Switching from the zwave2 adapter is easy because all information is stored on the coordinator.
You only need to wake up the battery-powered devices once so that zwave-js-ui can read them in again.


Activate WS Server Settings in `zwave-js-ui`
we use the Home Assistant Settings for this:

<img width="1959" height="786" alt="grafik" src="https://github.com/user-attachments/assets/9731b94f-a25f-41fd-bdc0-0236ecb4130b" />


## Changelog
### 0.0.2 (2026-01-06)
- (arteck) first release

## License

MIT License

Copyright (c) 2026 Arthur Rupp <arteck@outlook.com>,

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
