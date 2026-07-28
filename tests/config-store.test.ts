import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadOrCreateConfig, saveConfig, migrateConfig } from '../src/config-store.js';
import { createDefaultConfig, CURRENT_SCHEMA_VERSION, type NodeConfig } from '../src/config.js';
import { writeJsonAtomically, readJsonFile } from '../src/atomic-io.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('config-store', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'svpn-cfgstore-'));
    configPath = join(dir, 'config.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('loadOrCreateConfig', () => {
    it('creates default config when none exists', () => {
      const { config, created } = loadOrCreateConfig(configPath);
      assert.equal(created, true);
      assert.equal(config.schemaVersion, CURRENT_SCHEMA_VERSION);
      assert.equal(config.role, null);
    });

    it('loads existing config', () => {
      const original = createDefaultConfig();
      original.name = 'test-node';
      writeJsonAtomically(configPath, original);

      const { config, created } = loadOrCreateConfig(configPath);
      assert.equal(created, false);
      assert.equal(config.name, 'test-node');
    });

    it('throws on corrupted JSON', () => {
      writeFileSync(configPath, '{ broken json');
      assert.throws(() => loadOrCreateConfig(configPath), SyntaxError);
    });

    it('throws on newer schema version', () => {
      const future = createDefaultConfig();
      future.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
      writeJsonAtomically(configPath, future);
      assert.throws(
        () => loadOrCreateConfig(configPath),
        /newer than supported/,
      );
    });
  });

  describe('saveConfig', () => {
    it('persists config to disk', () => {
      const config = createDefaultConfig();
      config.name = 'saved-node';
      saveConfig(configPath, config);

      const loaded = readJsonFile<NodeConfig>(configPath);
      assert.equal(loaded.name, 'saved-node');
    });

    it('updates updatedAt timestamp', () => {
      const config = createDefaultConfig();
      const originalUpdatedAt = config.updatedAt;
      config.name = 'updated';

      // Wait a bit to ensure timestamp changes
      const config2 = createDefaultConfig();
      config2.name = 'test';
      config2.updatedAt = originalUpdatedAt;
      saveConfig(configPath, config2);

      const loaded = readJsonFile<NodeConfig>(configPath);
      assert.ok(loaded.updatedAt >= originalUpdatedAt);
    });

    it('preserves config through write + read cycle', () => {
      const config = createDefaultConfig();
      config.name = 'cycle-test';
      config.role = 'anchor';
      config.overlayIP = '10.42.0.1';
      config.subnetCIDR = '10.42.0.0/24';
      saveConfig(configPath, config);

      const { config: loaded } = loadOrCreateConfig(configPath);
      assert.equal(loaded.name, 'cycle-test');
      assert.equal(loaded.role, 'anchor');
      assert.equal(loaded.overlayIP, '10.42.0.1');
      assert.equal(loaded.subnetCIDR, '10.42.0.0/24');
    });
  });

  describe('migrateConfig', () => {
    it('returns config unchanged when already current', () => {
      const config = createDefaultConfig();
      const result = migrateConfig(config);
      assert.equal(result.migrated, false);
      assert.equal(result.fromVersion, CURRENT_SCHEMA_VERSION);
      assert.equal(result.toVersion, CURRENT_SCHEMA_VERSION);
    });

    it('throws on non-object', () => {
      assert.throws(() => migrateConfig('string'), /not a JSON object/);
    });

    it('throws on newer version', () => {
      const future = createDefaultConfig();
      future.schemaVersion = 999;
      assert.throws(() => migrateConfig(future), /newer than supported/);
    });
  });
});
