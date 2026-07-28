import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkNodeVersion, runPreflight } from '../src/preflight.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('preflight', () => {
  describe('checkNodeVersion', () => {
    it('accepts v20', () => {
      const result = checkNodeVersion('v20.0.0');
      assert.equal(result.ok, true);
      assert.equal(result.major, 20);
    });

    it('accepts v22', () => {
      const result = checkNodeVersion('v22.5.1');
      assert.equal(result.ok, true);
      assert.equal(result.major, 22);
    });

    it('rejects v18', () => {
      const result = checkNodeVersion('v18.20.0');
      assert.equal(result.ok, false);
      assert.equal(result.major, 18);
    });

    it('rejects v10', () => {
      const result = checkNodeVersion('v10.0.0');
      assert.equal(result.ok, false);
    });

    it('handles bare version without v prefix', () => {
      const result = checkNodeVersion('20.0.0');
      assert.equal(result.ok, true);
      assert.equal(result.major, 20);
    });
  });

  describe('runPreflight', () => {
    it('returns ok result with temp dir', () => {
      const base = join(tmpdir(), 'svpn-preflight-test');
      const result = runPreflight(base);
      assert.equal(result.ok, true);
      assert.equal(result.errors.length, 0);
      assert.equal(result.platform.os, process.platform);
      assert.equal(result.platform.arch, process.arch);
      assert.equal(result.paths.configDir, base);
    });

    it('includes nodeVersion', () => {
      const result = runPreflight(join(tmpdir(), 'svpn-preflight-test2'));
      assert.equal(typeof result.nodeVersion, 'string');
      assert.ok(result.nodeVersion.length > 0);
    });
  });
});
