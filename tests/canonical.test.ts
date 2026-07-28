import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jcsCanonicalize, jcsCanonicalizeString } from '../src/canonical.js';

describe('canonical (JCS)', () => {
  describe('jcsCanonicalize', () => {
    it('produces deterministic output for same object', () => {
      const obj1 = { b: 2, a: 1, c: 3 };
      const obj2 = { a: 1, b: 2, c: 3 };
      assert.deepEqual(jcsCanonicalize(obj1), jcsCanonicalize(obj2));
    });

    it('orders keys lexicographically', () => {
      const result = jcsCanonicalizeString({ b: 2, a: 1 });
      assert.equal(result, '{"a":1,"b":2}');
    });

    it('handles nested objects', () => {
      const result = jcsCanonicalizeString({ outer: { z: 1, a: 2 } });
      assert.equal(result, '{"outer":{"a":2,"z":1}}');
    });

    it('handles arrays (order preserved)', () => {
      const result = jcsCanonicalizeString({ arr: [3, 1, 2] });
      assert.equal(result, '{"arr":[3,1,2]}');
    });

    it('handles numbers', () => {
      assert.equal(jcsCanonicalizeString({ n: 42 }), '{"n":42}');
      assert.equal(jcsCanonicalizeString({ n: 3.14 }), '{"n":3.14}');
    });

    it('handles booleans and null', () => {
      assert.equal(jcsCanonicalizeString({ t: true, f: false, n: null }), '{"f":false,"n":null,"t":true}');
    });

    it('handles strings with special characters', () => {
      assert.equal(jcsCanonicalizeString({ s: 'hello "world"' }), '{"s":"hello \\"world\\""}');
    });

    it('produces Buffer', () => {
      const result = jcsCanonicalize({ a: 1 });
      assert.ok(Buffer.isBuffer(result));
    });

    it('throws on undefined', () => {
      assert.throws(() => jcsCanonicalize(undefined), /canonicalization failed/);
    });
  });
});
