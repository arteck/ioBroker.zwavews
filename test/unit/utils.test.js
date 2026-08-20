'use strict';

const assert = require('assert');
const utils = require('../../lib/utils');

describe('utils', () => {
    // ─── formatNodeId ────────────────────────────────────────────────────────────
    describe('formatNodeId', () => {
        it('should zero-pad a numeric node ID', () => {
            assert.strictEqual(utils.formatNodeId(1), 'nodeID_001');
            assert.strictEqual(utils.formatNodeId(12), 'nodeID_012');
            assert.strictEqual(utils.formatNodeId(123), 'nodeID_123');
        });

        it('should return a string node ID unchanged', () => {
            assert.strictEqual(utils.formatNodeId('nodeID_001'), 'nodeID_001');
        });

        it('should handle numeric string', () => {
            assert.strictEqual(utils.formatNodeId('5'), 'nodeID_005');
        });
    });

    // ─── isNumeric ───────────────────────────────────────────────────────────────
    describe('isNumeric', () => {
        it('should return true for integers', () => {
            assert.strictEqual(utils.isNumeric(0), true);
            assert.strictEqual(utils.isNumeric(42), true);
            assert.strictEqual(utils.isNumeric(-5), true);
        });

        it('should return true for numeric strings', () => {
            assert.strictEqual(utils.isNumeric('3.14'), true);
            assert.strictEqual(utils.isNumeric('-100'), true);
        });

        it('should return false for null/undefined/empty', () => {
            assert.strictEqual(utils.isNumeric(null), false);
            assert.strictEqual(utils.isNumeric(undefined), false);
            assert.strictEqual(utils.isNumeric(''), false);
            assert.strictEqual(utils.isNumeric('  '), false);
        });

        it('should return false for non-numeric strings', () => {
            assert.strictEqual(utils.isNumeric('abc'), false);
            assert.strictEqual(utils.isNumeric('12px'), false);
        });

        it('should return false for Infinity', () => {
            assert.strictEqual(utils.isNumeric(Infinity), false);
            assert.strictEqual(utils.isNumeric(NaN), false);
        });
    });

    // ─── formatObject ────────────────────────────────────────────────────────────
    describe('formatObject', () => {
        it('should replace spaces with underscores', () => {
            assert.strictEqual(utils.formatObject('hello world'), 'hello_world');
        });

        it('should replace ₂ with 2', () => {
            assert.strictEqual(utils.formatObject('CO₂ sensor'), 'CO2_sensor');
        });

        it('should trim leading/trailing whitespace', () => {
            assert.strictEqual(utils.formatObject('  test  '), 'test');
        });

        it('should return empty string for non-string input', () => {
            assert.strictEqual(utils.formatObject(null), '');
            assert.strictEqual(utils.formatObject(undefined), '');
            assert.strictEqual(utils.formatObject(42), '');
        });
    });

    // ─── deleteLastDot ───────────────────────────────────────────────────────────
    describe('deleteLastDot', () => {
        it('should remove trailing dot', () => {
            assert.strictEqual(utils.deleteLastDot('foo.bar.'), 'foo.bar');
        });

        it('should leave string unchanged if no trailing dot', () => {
            assert.strictEqual(utils.deleteLastDot('foo.bar'), 'foo.bar');
        });

        it('should return empty string for non-string input', () => {
            assert.strictEqual(utils.deleteLastDot(null), '');
            assert.strictEqual(utils.deleteLastDot(undefined), '');
        });
    });

    // ─── replaceLastDot ──────────────────────────────────────────────────────────
    describe('replaceLastDot', () => {
        it('should replace last dot with underscore', () => {
            assert.strictEqual(utils.replaceLastDot('a.b.c'), 'a.b_c');
        });

        it('should handle string with no dot', () => {
            assert.strictEqual(utils.replaceLastDot('abc'), 'abc');
        });

        it('should return empty string for non-string input', () => {
            assert.strictEqual(utils.replaceLastDot(null), '');
        });
    });

    // ─── getStatusText ───────────────────────────────────────────────────────────
    describe('getStatusText', () => {
        it('should return human-readable status for known codes', () => {
            assert.strictEqual(utils.getStatusText(0), 'Unknown');
            assert.strictEqual(utils.getStatusText(1), 'asleep');
            assert.strictEqual(utils.getStatusText(2), 'awake');
            assert.strictEqual(utils.getStatusText(3), 'dead');
            assert.strictEqual(utils.getStatusText(4), 'alive');
        });

        it('should return "Unknown" for unknown codes', () => {
            assert.strictEqual(utils.getStatusText(99), 'Unknown');
        });
    });

    // ─── getLastSegment ──────────────────────────────────────────────────────────
    describe('getLastSegment', () => {
        it('should return last dot-separated segment', () => {
            assert.strictEqual(utils.getLastSegment('a.b.c'), 'c');
        });

        it('should return last slash-separated segment', () => {
            assert.strictEqual(utils.getLastSegment('a/b/c'), 'c');
        });

        it('should return empty string for empty input', () => {
            assert.strictEqual(utils.getLastSegment(''), '');
        });

        it('should return empty string for non-string input', () => {
            assert.strictEqual(utils.getLastSegment(42), '');
        });
    });

    // ─── decimalToHex ────────────────────────────────────────────────────────────
    describe('decimalToHex', () => {
        it('should convert to zero-padded hex', () => {
            assert.strictEqual(utils.decimalToHex(255), 'ff');
            assert.strictEqual(utils.decimalToHex(15), '0f');
        });

        it('should respect custom padding', () => {
            assert.strictEqual(utils.decimalToHex(255, 4), '00ff');
        });
    });

    // ─── miredKelvinConversion ───────────────────────────────────────────────────
    describe('miredKelvinConversion', () => {
        it('should convert 4000K to ~250 mired', () => {
            assert.strictEqual(utils.miredKelvinConversion(4000), 250);
        });
    });

    // ─── toMired ─────────────────────────────────────────────────────────────────
    describe('toMired', () => {
        it('should leave values ≤ 1000 unchanged', () => {
            assert.strictEqual(utils.toMired(500), 500);
        });

        it('should convert values > 1000 to mired', () => {
            assert.strictEqual(utils.toMired(4000), 250);
        });
    });

    // ─── isObject ────────────────────────────────────────────────────────────────
    describe('isObject', () => {
        it('should return true for plain objects', () => {
            assert.strictEqual(utils.isObject({}), true);
            assert.strictEqual(utils.isObject({ a: 1 }), true);
        });

        it('should return false for arrays', () => {
            assert.strictEqual(utils.isObject([]), false);
        });

        it('should return false for null', () => {
            assert.strictEqual(utils.isObject(null), false);
        });

        it('should return false for primitives', () => {
            assert.strictEqual(utils.isObject(42), false);
            assert.strictEqual(utils.isObject('string'), false);
        });
    });

    // ─── isJson ──────────────────────────────────────────────────────────────────
    describe('isJson', () => {
        it('should return true for valid JSON object strings', () => {
            assert.strictEqual(utils.isJson('{"a":1}'), true);
        });

        it('should return true for objects', () => {
            assert.strictEqual(utils.isJson({ a: 1 }), true);
        });

        it('should return false for plain strings', () => {
            assert.strictEqual(utils.isJson('hello'), false);
        });

        it('should return false for null', () => {
            assert.strictEqual(utils.isJson(null), false);
        });
    });

    // ─── padNodeId ───────────────────────────────────────────────────────────────
    describe('padNodeId', () => {
        it('should zero-pad the numeric suffix', () => {
            assert.strictEqual(utils.padNodeId('nodeID_5'), 'nodeID_005');
            assert.strictEqual(utils.padNodeId('nodeID_12'), 'nodeID_012');
            assert.strictEqual(utils.padNodeId('nodeID_123'), 'nodeID_123');
        });
    });

});
