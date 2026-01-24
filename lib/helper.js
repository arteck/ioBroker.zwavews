const utils = require("./utils");
const constant = require("./constants");
const {isObject} = require("./utils");

/*
options:
write //set common write variable to true
forceIndex //instead of trying to find names for array entries, use the index as the name
channelName //set name of the root channel
preferedArrayName //set key to use this as an array entry name
autoCast (true false) // make JSON.parse to parse numbers correctly
descriptions: Object of names for state keys
*/
/**
 *
 */
class Helper {
  /**
   *
   * @param adapter
   * @param alreadyCreatedObjects
   */
  constructor(adapter, alreadyCreatedObjects = {}) {
    this.adapter = adapter;
    this.alreadyCreatedObjects = alreadyCreatedObjects;

  }

  /**
   *
   * @param path
   * @param element
   * @param options
   */


  /**
   *
   * @param nodeIdOriginal
   * @param element
   */
  async createNode(nodeIdOriginal, element) {
    try {
      let nodeId = utils.formatNodeId(nodeIdOriginal);

      if (element == null) {
        this.adapter.log.debug(`Cannot extract NodeId: ${nodeId}`);
        return;
      }

      await this.adapter.setObjectNotExistsAsync(nodeId, {
        type: 'device',
        common: {
          name: element.name ?? element.label,
          statusStates: {
            onlineId: `${this.adapter.name}.${this.adapter.instance}.${nodeId}.ready`,
          },
        },
        native: {},
      });

      await this.createReadyStatus(nodeId);

      const valuesOnly = element.values ?? null;
      delete element.values;
      await this.parse(`${nodeId}.info`, element);

      if (valuesOnly != null && typeof valuesOnly === "object" && valuesOnly.length > 0) {
        for (const v of valuesOnly) {
          let parsePath = `${nodeId}.${v.commandClassName}`;
          let metadata = v.metadata || {};

          if (constant.noInfoDP.includes(v.commandClassName)) {
            continue;
          }
          if (constant.noInfoDP.includes(v.propertyName)) {
            continue;
          }

          if (!this.alreadyCreatedObjects[parsePath]) {
            this.alreadyCreatedObjects[parsePath] = {};

            await this.adapter.setObjectNotExistsAsync(parsePath, {
              type: 'channel',
              common: {
                name: metadata.label || "",
              },
              native: {},
            });
          }

          parsePath = `${nodeId}.${v.commandClassName}.${v.propertyName
              .replace(/[^\p{L}\p{N}\s]/gu, "")
              .replace(/\s+/g, " ")
              .trim()}`;

          if (v?.propertyKeyName) {
            parsePath = `${parsePath}.${v.propertyKeyName
                .replace(/[^\p{L}\p{N}\s]/gu, "")
                .replace(/\s+/g, " ")
                .trim()}`;

            if (constant.RGB.includes(v.propertyKeyName)) {
              parsePath = utils.replaceLastDot(parsePath);
            }
          }

          if (this.isObject(v.value))  {   // da gibts ein object mit value
            parsePath = `${parsePath}_value`;
          }

          // mehr als 1 endpoint behandeln
          if (v.endpoint != null && v.endpoint > 0) {
            parsePath = `${parsePath}_${v.endpoint}`;
          }

          const nam_id = v.label ?? v.propertyName;

          metadata.value = v.value; // add value for resolution
          const valDp = this.resolveCommandClassValue(metadata) ?? 0;

          let typeDp = metadata.type === "timeout" ? "number" : metadata.type;

          if (constant.mixedType.includes(nam_id)) {
            typeDp = "mixed";
          }

          const common = {
            id:    nam_id,
            name:  nam_id,
            write: metadata.writeable,
            read:  metadata.readable,
            desc:  metadata.label,
            type:  typeDp,
            min:   metadata?.min,
            max:   metadata?.max,
            def:   v.default ?? (typeDp === "boolean" ? false : metadata?.min),
            unit: metadata?.unit ?? "",
            role: this.getRole(valDp, metadata.writeable, parsePath),
          };

          if (metadata?.states) {
              common.states = metadata?.states;
          }
          const native = {
             valueId : { commandClass: v.commandClass,
                                 endpoint: v.endpoint,
                                 property: v.property
             }
          };

          if (v?.propertyKey) {
            native.valueId.propertyKey = v.propertyKey;
          }

          await this.adapter.setObjectNotExistsAsync(parsePath, {
            type: 'state',
            common,
            native,
          });



          if (common.write === true) {
            this.adapter.subscribeStates(parsePath);
          }

          this.alreadyCreatedObjects[parsePath] = {  };

          this.adapter.setState(parsePath, valDp, true);

        }
      }
    } catch (error) {
      this.adapter.log.error(`Cannot create node ${nodeIdOriginal} : ${error}`);
    }
  }

  /**
   *
   * @param path
   * @param element
   * @param options
   */
  async parse(path, element, options = { write: false }) {
    let parsePath = path;

    if (element == null) {
      this.adapter.log.debug(`Cannot extract empty: ${parsePath}`);
      return;
    }

    if (typeof element === "string" || typeof element === "number" || typeof element === "boolean") {
      let valDp = element ?? 0;

      let typeDp = typeof element;

      if (!this.alreadyCreatedObjects[parsePath]) {
        try {
          let common = {};
          if (typeof element === "string" || typeof element === "number") {
            common = {
              id: parsePath,
              name: parsePath,
              role: this.getRole(element, options.write),
              type: typeDp,
              write: options.write,
              read: true,
            };
          }
          await this.adapter.setObjectNotExistsAsync(parsePath, {
            type: 'state',
            common,
            native: { },
          });

          if (common.write === true) {
            this.adapter.subscribeStates(parsePath);
          }

          this.alreadyCreatedObjects[parsePath] = {};
        } catch (error) {
          this.adapter.log.error(error);
        }
      }

      this.adapter.setState(parsePath, valDp, true);
      return;
    }
    options.channelName = utils.getLastSegment(parsePath);

    if (!this.alreadyCreatedObjects[parsePath]) {
      try {
          await this.adapter.setObjectNotExistsAsync(parsePath, {
            type: "channel",
            common: {
              name: options.channelName || ""
            },
            native: {},
          });

        this.alreadyCreatedObjects[parsePath] = { };
        delete options.channelName;
      } catch (error) {
        this.adapter.log.error(error);
      }
    }

    if (Array.isArray(element)) {
      await this.extractArray(element, "", parsePath, options);
      return;
    }

    // ------------------------           info schleife

    const hasName2 = "name" in (element ?? {});
    if (!hasName2 && this.isObject(element)) {
      element.name = "";
    }

    for (const key of Object.keys(element)) {
      let fullPath = `${parsePath}.${key}`;
      let valDP = element[key];

      if (Array.isArray(valDP)) {
        try {
          if (!constant.noInfoDP.includes(key)) {
            await this.extractArray(element, key, parsePath, options);
          }
        } catch (error) {
          this.adapter.log.error(`extractArray ${error}`);
        }
        continue;
      }

      const isObj = this.isObject(valDP);

      if (isObj) {
        if (Object.keys(valDP).length > 0) {
          options.write = false;
          await this.parse(fullPath, valDP, options);
        }
        continue;
      }

      switch (key) {
        case "ready":
          fullPath = fullPath.replace(".info.", ".");
          break;
        case "status":
          fullPath = fullPath.replace(".info.", ".");
          if (utils.isNumeric(valDP)) {
            valDP = utils.getStatusText(valDP);
          }
          break;
        default:
            break;
      }

      if (!this.alreadyCreatedObjects[fullPath]) {
        const objectName = options.descriptions?.[key] || key;
        let typeDp = typeof valDP === "string" ? "mixed" : (valDP != null ? typeof valDP : "mixed");

        if (constant.mixedType.includes(key)) {
          typeDp = "mixed";
        }

        const common = {
          id: objectName,
          name: objectName,
          role: this.getRole(valDP, options, key),
          type: typeDp,
          write: options.write,
          read: true,
        };

        await this.adapter.setObjectNotExistsAsync(fullPath, {
          type: 'state',
          common,
          native: { },
        });

        if (options.write === true) {
          this.adapter.subscribeStates(fullPath);
        }

        this.alreadyCreatedObjects[fullPath] = { };
      }

      try {
        if (valDP !== undefined) {
          this.adapter.setState(fullPath, valDP, true);
        }
      } catch (err) {
        this.adapter.log.warn(`ERROR ${valDP} ${JSON.stringify(err)}`);
      }
    }
  }


  /**
   *
   * @param value
   */
  isObject(value) {
    return value !== null && typeof value === "object";
  }

  /**
   *
   * @param element
   * @param key
   * @param path
   * @param options
   */
  async extractArray(element, key, path, options) {
    try {
      const array = key ? element[key] : element;

      for (let i = 0; i < array.length; i++) {
        const arrayElement = array[i];
     //   const index = (i + 1).toString().padStart(2, "0");

        if (typeof arrayElement === "string") {
          if (key === undefined || key === "") {
            key = arrayElement;
          }

          await this.parse(
            `${path}.${key}.${arrayElement}`,
            arrayElement,
            options,
          );
          continue;
        }

        await this.parse(`${path}.${key}`, arrayElement, options);
      }
    } catch (error) {
      this.adapter.log.error(`Cannot extract array ${path}`);
    }
  }

  /**
   *
   * @param element
   * @param options
   * @param dpName
   */
  getRole(element, options, dpName) {
    const write = options.write;
    const hasStates = element && typeof element === "object" && element.states !== undefined;


    if (constant.timeKey.includes(dpName)) {
      // check ob es sich um ein timestamp handelt
      return "value.time";
    }

    if (hasStates) {
      if (element.type == "boolean") {
        delete element.states;
        return "button";
      }
      return "switch";
    }

    if (typeof element === "string") {
      return "text";
    }

    if (typeof element === "boolean") {
      return "switch";
    }


    return "state";
  }
  /**
   *
   * @param element
   */
  resolveCommandClassValue(element) {
    const type = element.type;

    if (type === "any" || type === "color") {
      element.type = "mixed";
      return typeof element.value === "object"
        ? JSON.stringify(element.value)
        : element.value;
    }

    if (type.includes("string")) {
      element.type = "mixed";
      if (element.writeable === false) {
        let v = element.value ?? element.min ?? 0;
        if (Array.isArray(v) && v.length) {
          v = JSON.stringify(v);
        }
        return v;
      }
      return element.value ?? element.min ?? 0;
    }

    if (type.includes("buffer")) {
      element.type = "mixed";
      if (element.writeable === false) {
        let v = element.value ?? element.min ?? 0;
        if (Array.isArray(v) && v.length) {
          v = v[0];
        }
        return v;
      }
      return element.value ?? element.min ?? 0;
    }

    if (type === "duration") {
      element.type = "mixed";
      let v = element.value ?? element.min ?? 0;
      if (typeof v === "object") {
        if (v?.unit) {
          element.unit = v.unit;
        }
        v = 0;
      }
      return v;
    }

    if (type === "number") {
      if (element?.value) {
        return utils.isNumeric(element.value) ? element.value : 0;
      }
      return element.value ?? element.min;
    }

    return element.readable === false
      ? false
      : (element.value ?? (type === "boolean" ? false : (element.min ?? 0)));
  }


  /**
   *
   * @param nodeId
   */
  async createReadyStatus(nodeId) {
     // leg die status direkt auch an
      let common = {
        id: 'ready',
        name: 'ready',
        role: 'indicator.reachable',
        type: 'boolean',
        write: false,
        read: true,
      };
      await this.adapter.setObjectNotExistsAsync(`${nodeId}.ready`, {
        type: 'state',
        common,
        native: {},
      });

      common = {
        id: 'status',
        name: 'status',
        role: 'state',
        type: 'string',
        write: false,
        read: true,
      };

      await this.adapter.setObjectNotExistsAsync(`${nodeId}.status`, {
        type: 'state',
        common,
        native: {},
      });
  }
/**
 *
 * @param nodeId
 * @param element
 * @param nameChange
 */
  async updateDevice(nodeId, element, nameChange = true) {
    const obj = await this.adapter.getObjectAsync(nodeId);
    if (obj) {
      if (nameChange) {
        const newName = element.name || element.productLabel || element.manufacturer || element.newValue;

        if (obj.common?.name !== newName) {
          obj.common = obj.common ?? {};
          obj.common.name = newName;
        } else {
          const newDesc = element.desc;
          obj.common = obj.common ?? {};
          obj.common.desc = newDesc;
        }
        await this.adapter.setObjectAsync(nodeId, obj);
      }
    }
  }
}

module.exports = {
  Helper: Helper,
};
