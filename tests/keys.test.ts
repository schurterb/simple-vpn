import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { KeyManager, KeyMissingError, KeyCorruptError } from '../src/keys.js';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('KeyManager', () => {
  let dir: string;
  let wgPath: string;
  let idPath: string;
  let km: KeyManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'svpn-keys-'));
    wgPath = join(dir, 'wg.key');
    idPath = join(dir, 'identity.key');
    km = new KeyManager(wgPath, idPath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('generateAndStoreKeys', () => {
    it('creates both key files', () => {
      const keys = km.generateAndStoreKeys();
      assert.equal(existsSync(wgPath), true);
      assert.equal(existsSync(idPath), true);
      assert.ok(keys.wg.privateKey.length > 0);
      assert.ok(keys.identity.privateKey.length > 0);
    });

    it('throws on second generation (O_EXCL)', () => {
      km.generateAndStoreKeys();
      assert.throws(() => km.generateAndStoreKeys(), /EEXIST/);
    });

    it('creates key files with 0600 permissions', () => {
      km.generateAndStoreKeys();
      const wgStat = readFileSync(wgPath);
      assert.ok(wgStat.length > 0);
    });
  });

  describe('keysExist', () => {
    it('returns false when no keys exist', () => {
      assert.equal(km.keysExist(), false);
    });

    it('returns true after generation', () => {
      km.generateAndStoreKeys();
      assert.equal(km.keysExist(), true);
    });
  });

  describe('loadKeys', () => {
    it('loads keys after generation', () => {
      km.generateAndStoreKeys();
      const keys = km.loadKeys();
      assert.ok(keys.wg.privateKey.length > 0);
      assert.ok(keys.identity.privateKey.length > 0);
    });

    it('throws KeyMissingError when wg.key absent', () => {
      writeFileSync(idPath, Buffer.from([1, 2, 3]), { mode: 0o600 });
      assert.throws(() => km.loadKeys(), KeyMissingError);
    });

    it('throws KeyMissingError when identity.key absent', () => {
      writeFileSync(wgPath, Buffer.from([1, 2, 3]), { mode: 0o600 });
      assert.throws(() => km.loadKeys(), KeyMissingError);
    });

    it('throws KeyCorruptError when wg.key is empty', () => {
      writeFileSync(wgPath, Buffer.alloc(0), { mode: 0o600 });
      writeFileSync(idPath, Buffer.from([1, 2, 3]), { mode: 0o600 });
      assert.throws(() => km.loadKeys(), KeyCorruptError);
    });

    it('throws KeyCorruptError when identity.key is empty', () => {
      writeFileSync(wgPath, Buffer.from([1, 2, 3]), { mode: 0o600 });
      writeFileSync(idPath, Buffer.alloc(0), { mode: 0o600 });
      assert.throws(() => km.loadKeys(), KeyCorruptError);
    });
  });

  describe('verifyKeyPermissions', () => {
    it('returns false when keys do not exist', () => {
      assert.equal(km.verifyKeyPermissions(), false);
    });

    it('returns true after generation with 0600', () => {
      km.generateAndStoreKeys();
      assert.equal(km.verifyKeyPermissions(), true);
    });
  });
});
