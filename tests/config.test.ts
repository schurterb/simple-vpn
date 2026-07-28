import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultConfig,
  validateConfig,
  assertValidConfig,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_UI_PORT,
  type NodeConfig,
} from '../src/config.js';

describe('config schema', () => {
  describe('createDefaultConfig', () => {
    it('creates config with current schema version', () => {
      const config = createDefaultConfig();
      assert.equal(config.schemaVersion, CURRENT_SCHEMA_VERSION);
    });

    it('creates config with default UI port', () => {
      const config = createDefaultConfig();
      assert.equal(config.uiPort, DEFAULT_UI_PORT);
    });

    it('creates config with null role', () => {
      const config = createDefaultConfig();
      assert.equal(config.role, null);
    });

    it('creates config with integer timestamps', () => {
      const config = createDefaultConfig();
      assert.equal(Number.isInteger(config.createdAt), true);
      assert.equal(Number.isInteger(config.updatedAt), true);
    });
  });

  describe('validateConfig', () => {
    it('validates a correct default config', () => {
      const config = createDefaultConfig();
      const errors = validateConfig(config);
      assert.equal(errors.length, 0);
    });

    it('rejects non-object', () => {
      const errors = validateConfig('not an object');
      assert.equal(errors.length, 1);
      assert.equal(errors[0]!.field, 'root');
    });

    it('rejects null', () => {
      const errors = validateConfig(null);
      assert.equal(errors.length, 1);
    });

    it('rejects missing schemaVersion', () => {
      const config = createDefaultConfig();
      delete (config as unknown as Record<string, unknown>)['schemaVersion'];
      const errors = validateConfig(config);
      assert.ok(errors.some((e) => e.field === 'schemaVersion'));
    });

    it('rejects non-integer schemaVersion', () => {
      const config = createDefaultConfig();
      config.schemaVersion = 1.5;
      const errors = validateConfig(config);
      assert.ok(errors.some((e) => e.field === 'schemaVersion'));
    });

    it('rejects invalid role', () => {
      const config = createDefaultConfig();
      config.role = 'invalid' as NodeConfig['role'];
      const errors = validateConfig(config);
      assert.ok(errors.some((e) => e.field === 'role'));
    });

    it('accepts anchor role', () => {
      const config = createDefaultConfig();
      config.role = 'anchor';
      const errors = validateConfig(config);
      assert.equal(errors.length, 0);
    });

    it('accepts member role', () => {
      const config = createDefaultConfig();
      config.role = 'member';
      const errors = validateConfig(config);
      assert.equal(errors.length, 0);
    });

    it('rejects out-of-range uiPort', () => {
      const config = createDefaultConfig();
      config.uiPort = 0;
      const errors = validateConfig(config);
      assert.ok(errors.some((e) => e.field === 'uiPort'));
    });

    it('rejects uiPort > 65535', () => {
      const config = createDefaultConfig();
      config.uiPort = 70000;
      const errors = validateConfig(config);
      assert.ok(errors.some((e) => e.field === 'uiPort'));
    });

    it('rejects name too long', () => {
      const config = createDefaultConfig();
      config.name = 'a'.repeat(33);
      const errors = validateConfig(config);
      assert.ok(errors.some((e) => e.field === 'name'));
    });

    it('rejects non-integer createdAt', () => {
      const config = createDefaultConfig();
      config.createdAt = 1.5;
      const errors = validateConfig(config);
      assert.ok(errors.some((e) => e.field === 'createdAt'));
    });
  });

  describe('assertValidConfig', () => {
    it('returns config when valid', () => {
      const config = createDefaultConfig();
      const result = assertValidConfig(config);
      assert.equal(result.schemaVersion, CURRENT_SCHEMA_VERSION);
    });

    it('throws on invalid config', () => {
      assert.throws(() => assertValidConfig({ schemaVersion: 'bad' }), /Config validation failed/);
    });
  });
});
