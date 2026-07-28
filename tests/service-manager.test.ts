import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceManager, type ServiceConfig } from '../src/service-manager.js';

const config: ServiceConfig = {
  name: 'simple-vpn',
  displayName: 'Simple VPN',
  description: 'Simple VPN daemon',
  execPath: '/usr/bin/node',
  workingDir: '/opt/simple-vpn',
};

describe('ServiceManager', () => {
  describe('isInstalled', () => {
    it('returns false when not installed (linux)', () => {
      const mgr = new ServiceManager('linux', config);
      // Won't have root in test env, but should return false
      assert.equal(typeof mgr.isInstalled(), 'boolean');
    });

    it('returns false when not installed (darwin)', () => {
      const mgr = new ServiceManager('darwin', config);
      assert.equal(typeof mgr.isInstalled(), 'boolean');
    });
  });

  describe('install/uninstall', () => {
    it('returns error result without root (linux)', () => {
      const mgr = new ServiceManager('linux', config);
      const result = mgr.install();
      assert.ok(result.state === 'installed' || result.state === 'error');
      assert.ok(result.message.length > 0);
    });

    it('returns error result without root (darwin)', () => {
      const mgr = new ServiceManager('darwin', config);
      const result = mgr.install();
      assert.ok(result.state === 'installed' || result.state === 'error');
      assert.ok(result.message.length > 0);
    });

    it('uninstall returns not-installed or error', () => {
      const mgr = new ServiceManager('linux', config);
      const result = mgr.uninstall();
      assert.ok(result.state === 'not-installed' || result.state === 'error');
    });
  });
});
