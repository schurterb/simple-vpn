import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getConfigPaths } from '../src/config-paths.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('config-paths', () => {
  describe('getConfigPaths', () => {
    it('returns correct paths for linux', () => {
      const base = join(tmpdir(), 'svpn-test-linux');
      const paths = getConfigPaths('linux', base);
      assert.equal(paths.configDir, base);
      assert.equal(paths.configPath, join(base, 'config.json'));
      assert.equal(paths.wgKeyPath, join(base, 'wg.key'));
      assert.equal(paths.identityKeyPath, join(base, 'identity.key'));
      assert.equal(paths.journalPath, join(base, 'journal.jsonl'));
      assert.equal(paths.lockFile, join(base, 'simple-vpn.lock'));
      assert.equal(paths.logDir, join(base, 'logs'));
      assert.equal(paths.sessionDir, join(base, 'sessions'));
    });

    it('returns correct paths for darwin', () => {
      const base = join(tmpdir(), 'svpn-test-darwin');
      const paths = getConfigPaths('darwin', base);
      assert.equal(paths.configDir, base);
      assert.equal(paths.configPath, join(base, 'config.json'));
    });

    it('returns correct paths for win32', () => {
      const base = join(tmpdir(), 'svpn-test-win32');
      const paths = getConfigPaths('win32', base);
      assert.equal(paths.configDir, base);
      assert.equal(paths.configPath, join(base, 'config.json'));
    });

    it('uses default config dir when baseDir omitted', () => {
      const paths = getConfigPaths('linux');
      assert.equal(paths.configDir, '/etc/simple-vpn');
    });

    it('darwin default uses Application Support', () => {
      const paths = getConfigPaths('darwin');
      assert.equal(paths.configDir, '/Library/Application Support/simple-vpn');
    });
  });
});
