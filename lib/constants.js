 
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
const RGB = [];

const api_schema = 50;

// DPs die propertyKey=0 als echten Wert haben (nicht Default)
// Format: { "commandClassName": ["propertyName", ...] }
const MEANINGFUL_PROPERTY_KEYS = {
    "Color Switch": ["currentColor", "targetColor"]
};

module.exports = {
    timeKey,
    noInfoDP,
    mixedType,
    RGB,
    api_schema,
    MEANINGFUL_PROPERTY_KEYS
};
