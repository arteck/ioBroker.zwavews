const constants = require("node:constants");

/**
 *
 * @param config
 * @param log
 */
async function adapterInfo(config, log) {
    log.info(
        "================================= Adapter Config =================================",
    );
    log.info(`|| zwaveWS Frontend Scheme: ${config.webUIScheme}`);
    log.info(`|| zwaveWS Frontend Server: ${config.webUIServer}`);
    log.info(`|| zwaveWS Frontend Port: ${config.webUIPort}`);
    log.info(`|| zwaveWS Connection Type: ${config.connectionType}`);
    if (config.connectionType === "ws") {
        log.info(`|| zwaveWS Websocket Scheme: ${config.wsScheme}`);
        log.info(`|| zwaveWS Websocket Server: ${config.wsServerIP}`);
        log.info(`|| zwaveWS Websocket Port: ${config.wsServerPort}`);
        log.info(
            `|| zwaveWS Websocket Auth-Token: ${config.wsTokenEnabled ? "use" : "unused"}`,
        );
    }
    log.info(
        "==================================================================================",
    );
}

module.exports = {
    adapterInfo,
};
