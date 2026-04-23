'use strict';

const assert = require('assert');
const { Helper } = require('../../lib/helper');

/**
 * Erstellt einen minimalen Mock-Adapter für Tests.
 */
function createMockAdapter() {
    const createdObjects = {};
    const states = {};
    const subscriptions = [];
    const logs = { info: [], warn: [], error: [], debug: [] };

    return {
        log: {
            info:  (msg) => logs.info.push(msg),
            warn:  (msg) => logs.warn.push(msg),
            error: (msg) => logs.error.push(msg),
            debug: (msg) => logs.debug.push(msg),
        },
        logs,
        createdObjects,
        states,
        subscriptions,
        async setObjectNotExistsAsync(id, obj) {
            createdObjects[id] = obj;
        },
        async setObjectAsync(id, obj) {
            createdObjects[id] = obj;
        },
        async getObjectAsync(id) {
            return createdObjects[id] ?? null;
        },
        async setStateAsync(id, val, ack) {
            states[id] = { val, ack };
        },
        async setStateChangedAsync(id, val, ack) {
            states[id] = { val, ack };
        },
        subscribeStates(id) {
            subscriptions.push(id);
        },
    };
}

// ─── normalizeType ───────────────────────────────────────────────────────────
describe('Helper.normalizeType', () => {
    let helper;
    before(() => {
        helper = new Helper(createMockAdapter(), {});
    });

    it('should use a valid hint', () => {
        assert.strictEqual(helper.normalizeType(42, 'number'), 'number');
        assert.strictEqual(helper.normalizeType('x', 'boolean'), 'boolean');
    });

    it('should ignore invalid hints', () => {
        assert.strictEqual(helper.normalizeType(42, 'rubbish'), 'number');
    });

    it('should detect array', () => {
        assert.strictEqual(helper.normalizeType([1, 2]), 'array');
    });

    it('should detect number', () => {
        assert.strictEqual(helper.normalizeType(3.14), 'number');
    });

    it('should detect boolean', () => {
        assert.strictEqual(helper.normalizeType(false), 'boolean');
    });

    it('should return "mixed" for strings', () => {
        assert.strictEqual(helper.normalizeType('hello'), 'mixed');
    });
});

// ─── getRole ─────────────────────────────────────────────────────────────────
describe('Helper.getRole', () => {
    let helper;
    before(() => {
        helper = new Helper(createMockAdapter(), {});
    });

    it('should return "value.time" for time keys', () => {
        assert.strictEqual(helper.getRole(0, {}, 'lastActive'), 'value.time');
        assert.strictEqual(helper.getRole(0, {}, 'lastUpdate'), 'value.time');
    });

    it('should return "text" for string values', () => {
        assert.strictEqual(helper.getRole('alive', {}), 'text');
    });

    it('should return "switch" for boolean values', () => {
        assert.strictEqual(helper.getRole(true, {}), 'switch');
        assert.strictEqual(helper.getRole(false, {}), 'switch');
    });

    it('should return "state" as default', () => {
        assert.strictEqual(helper.getRole(42, {}), 'state');
    });

    it('should return "button" for boolean metadata with states', () => {
        const meta = { type: 'boolean', states: { 0: 'off', 1: 'on' } };
        assert.strictEqual(helper.getRole(meta, {}), 'button');
        assert.strictEqual(meta.states, undefined); // states should be deleted
    });

    it('should return "switch" for non-boolean metadata with states', () => {
        const meta = { type: 'number', states: { 0: 'off', 1: 'on' } };
        assert.strictEqual(helper.getRole(meta, {}), 'switch');
    });
});

// ─── resolveCommandClassValue ────────────────────────────────────────────────
describe('Helper.resolveCommandClassValue', () => {
    let helper;
    before(() => {
        helper = new Helper(createMockAdapter(), {});
    });

    it('should return value for numeric type', () => {
        assert.strictEqual(helper.resolveCommandClassValue({ type: 'number', value: 50 }), 50);
    });

    it('should fall back to min for number type when value is null', () => {
        assert.strictEqual(helper.resolveCommandClassValue({ type: 'number', value: null, min: 0 }), 0);
    });

    it('should return 0 for non-numeric value in number type', () => {
        assert.strictEqual(helper.resolveCommandClassValue({ type: 'number', value: 'abc' }), 0);
    });

    it('should stringify object value for "any" type', () => {
        const meta = { type: 'any', value: { r: 255 } };
        assert.strictEqual(helper.resolveCommandClassValue(meta), '{"r":255}');
        assert.strictEqual(meta.type, 'mixed');
    });

    it('should handle duration type as object by returning 0', () => {
        const meta = { type: 'duration', value: { value: 5, unit: 's' } };
        assert.strictEqual(helper.resolveCommandClassValue(meta), 0);
        assert.strictEqual(meta.unit, 's');
    });

    it('should handle duration type as number', () => {
        const meta = { type: 'duration', value: 10 };
        assert.strictEqual(helper.resolveCommandClassValue(meta), 10);
    });

    it('should return false for boolean type when readable is false', () => {
        assert.strictEqual(
            helper.resolveCommandClassValue({ type: 'boolean', readable: false }),
            false,
        );
    });

    it('should return false when no type given and no value', () => {
        assert.strictEqual(helper.resolveCommandClassValue({}), 0);
    });
});

// ─── changeState ─────────────────────────────────────────────────────────────
describe('Helper.changeState', () => {
    let adapter;
    let helper;

    beforeEach(() => {
        adapter = createMockAdapter();
        helper = new Helper(adapter, {});
    });

    it('should use setStateAsync when change=true', async () => {
        await helper.changeState('test.path', 42, true);
        assert.deepStrictEqual(adapter.states['test.path'], { val: 42, ack: true });
    });

    it('should use setStateChangedAsync when change=false (default)', async () => {
        await helper.changeState('test.path', 'alive');
        assert.deepStrictEqual(adapter.states['test.path'], { val: 'alive', ack: true });
    });
});

// ─── updateDevice ─────────────────────────────────────────────────────────────
describe('Helper.updateDevice', () => {
    let adapter;
    let helper;

    beforeEach(() => {
        adapter = createMockAdapter();
        helper = new Helper(adapter, {});
        // Vorbelegung: Gerät existiert im Mock
        adapter.createdObjects['nodeID_001'] = {
            type: 'device',
            common: { name: 'Old Name' },
            native: {},
        };
    });

    it('should update name when nameChange=true', async () => {
        await helper.updateDevice('nodeID_001', { name: 'New Name' }, true);
        assert.strictEqual(adapter.createdObjects['nodeID_001'].common.name, 'New Name');
    });

    it('should update desc when nameChange=false', async () => {
        await helper.updateDevice('nodeID_001', { desc: 'Node is Deleted' }, false);
        assert.strictEqual(adapter.createdObjects['nodeID_001'].common.desc, 'Node is Deleted');
    });

    it('should do nothing when object not found', async () => {
        await helper.updateDevice('nodeID_999', { name: 'X' }, true);
        assert.strictEqual(adapter.createdObjects['nodeID_999'], undefined);
    });

    it('should not overwrite name when new name is same', async () => {
        let callCount = 0;
        const origSetObject = adapter.setObjectAsync.bind(adapter);
        adapter.setObjectAsync = async (id, obj) => { callCount++; return origSetObject(id, obj); };

        await helper.updateDevice('nodeID_001', { name: 'Old Name' }, true);
        assert.strictEqual(callCount, 0, 'setObjectAsync should NOT be called when name has not changed');
    });
});

// ─── parse – primitive values ─────────────────────────────────────────────────
describe('Helper.parse – primitive values', () => {
    let adapter;
    let helper;

    beforeEach(() => {
        adapter = createMockAdapter();
        helper = new Helper(adapter, {});
    });

    it('should create and set a string state', async () => {
        await helper.parse('nodeID_001.info.status', 'alive', {});
        assert.ok(adapter.createdObjects['nodeID_001.info.status'], 'Object should be created');
        assert.strictEqual(adapter.states['nodeID_001.info.status'].val, 'alive');
    });

    it('should create and set a number state', async () => {
        await helper.parse('nodeID_001.info.level', 75, {});
        assert.strictEqual(adapter.createdObjects['nodeID_001.info.level'].common.type, 'number');
        assert.strictEqual(adapter.states['nodeID_001.info.level'].val, 75);
    });

    it('should create and set a boolean state', async () => {
        await helper.parse('nodeID_001.ready', true, {});
        assert.strictEqual(adapter.createdObjects['nodeID_001.ready'].common.type, 'boolean');
        assert.strictEqual(adapter.createdObjects['nodeID_001.ready'].common.role, 'switch');
    });

    it('should not create object twice (cache check)', async () => {
        await helper.parse('nodeID_001.info.level', 10, {});
        const before = Object.keys(adapter.createdObjects).length;
        await helper.parse('nodeID_001.info.level', 20, {});
        assert.strictEqual(Object.keys(adapter.createdObjects).length, before);
    });

    it('should subscribe when write=true', async () => {
        await helper.parse('nodeID_001.info.target', 50, { write: true });
        assert.ok(adapter.subscriptions.includes('nodeID_001.info.target'));
    });

    it('should not subscribe when write=false', async () => {
        await helper.parse('nodeID_001.info.read', 50, { write: false });
        assert.ok(!adapter.subscriptions.includes('nodeID_001.info.read'));
    });

    it('should not mutate the options object', async () => {
        const options = { write: true };
        await helper.parse('nodeID_001.info.obj', { sub: 1 }, options);
        assert.strictEqual(options.write, true, 'options.write should not be changed');
    });
});
