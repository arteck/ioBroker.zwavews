 
'use strict';

const timeKey = [
      "lastActive",
      "lastUpdate"
    ];
const noInfoDP = [
      "eventsQueue",
      "rfRegions",
      "Scene Actuator Configuration",
      "dimmingDuration",
      "paramInformation",
    ];
const mixedType  = [
        "interviewStage",
        "overrideState"     
    ];
const RGB = ["Red", "Green", "Blue"];

const api_schema = 50;

module.exports = {
    timeKey,
    noInfoDP,
    mixedType,
    RGB,
    api_schema
};
