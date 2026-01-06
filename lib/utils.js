/**
 *
 * @param ba
 */
function bytesArrayToWordArray(ba) {
  const wa = [];
  for (let i = 0; i < ba.length; i++) {
    wa[(i / 2) | 0] |= ba[i] << (8 * (i % 2));
  }
  return wa;
}

// If the value is greater than 1000, kelvin is assumed.
// If smaller, it is assumed to be mired.
/**
 *
 * @param t
 */
function toMired(t) {
  let miredValue = t;
  if (t > 1000) {
    miredValue = miredKelvinConversion(t);
  }
  return miredValue;
}

/**
 *
 * @param t
 */
function miredKelvinConversion(t) {
  return Math.round(1000000 / t);
}

/**
 * Converts a decimal number to a hex string with zero-padding
 *
 * @param decimal
 * @param padding
 */
function decimalToHex(decimal, padding) {
  let hex = Number(decimal).toString(16);
  padding =
    typeof padding === "undefined" || padding === null
      ? (padding = 2)
      : padding;

  while (hex.length < padding) {
    hex = `0${hex}`;
  }

  return hex;
}

/**
 *
 * @param array
 */
function clearArray(array) {
  while (array.length > 0) {
    array.pop();
  }
}

/**
 *
 * @param source
 * @param target
 */
function moveArray(source, target) {
  while (source.length > 0) {
    target.push(source.shift());
  }
}

/**
 *
 * @param item
 */
function isObject(item) {
  return typeof item === "object" && !Array.isArray(item) && item !== null;
}

/**
 *
 * @param item
 */
function isJson(item) {
  let value = typeof item !== "string" ? JSON.stringify(item) : item;
  try {
    value = JSON.parse(value);
  } catch (e) {
    return false;
  }

  return typeof value === "object" && value !== null;
}

/**
 *
 * @param input
 */
function getLastSegment(input) {
  if (typeof input !== "string") {
    return "";
  }
  const parts = input.split(/[./]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function isNumeric(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (s === "") {
      return false;
    }
    return /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(s);
  }
  return false;
}

/**
 *
 * @param str
 */
function replaceLastDot(str) {
  const idx = str.lastIndexOf(".");
  return idx >= 0 ? `${str.slice(0, idx)}_${str.slice(idx + 1)}` : str;
}
/**
 *
 * @param input
 */
function formatMQTT(input) {
  if (typeof input !== "string") {
    return "";
  }
  return input.replace(/\./g, "/");
}

/**
 *
 * @param nodeId
 * @param width
 */
function padNodeId(nodeId, width = 3) {
  return nodeId.replace(/(\d+)$/, (m) => m.padStart(width, "0"));
}

/**
 *
 * @param status
 */
function getStatusText(status) {
  const nodeStatus = {
    0: "Unknown",
    1: "Asleep",
    2: "Awake",
    3: "Dead",
    4: "Alive",
  };

  return nodeStatus[status] || "Unknown";
}

/**
 *
 * @param nodeIdOriginal
 */
function formatNodeId(nodeIdOriginal) {
  let nodeId = nodeIdOriginal;

  if (this.isNumeric(nodeIdOriginal)) {
    nodeId = this.padNodeId(`nodeID_${nodeIdOriginal}`);
  }
  return nodeId;
}

module.exports = {
  bytesArrayToWordArray,
  toMired,
  miredKelvinConversion,
  decimalToHex,
  formatNodeId,
  clearArray,
  moveArray,
  isObject,
  isJson,
  getLastSegment,
  isNumeric,
  replaceLastDot,
  formatMQTT,
  padNodeId,
  getStatusText,
};
