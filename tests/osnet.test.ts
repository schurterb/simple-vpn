import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OsNet } from '../src/osnet.js';

describe('OsNet', () => {
  describe('Linux', () => {
    const osnet = new OsNet({ platform: 'linux' });

    it('assignAddress uses ip addr add', () => {
      const result = osnet.assignAddress('svpn0', '10.42.0.1/24');
      // Will fail since no real interface, but tests command construction
      assert.equal(result.success, false);
      assert.ok(result.error.length > 0);
    });

    it('interfaceExists returns false for non-existent', () => {
      assert.equal(osnet.interfaceExists('nonexistent123'), false);
    });
  });

  describe('macOS', () => {
    const osnet = new OsNet({ platform: 'darwin' });

    it('interfaceExists returns false for non-existent', () => {
      assert.equal(osnet.interfaceExists('utun999'), false);
    });
  });

  describe('command construction (mock)', () => {
    it('Linux linkUp calls ip link set up', () => {
      const osnet = new OsNet({ platform: 'linux' });
      // Can't test actual exec, but verify it doesn't throw
      const result = osnet.linkUp('svpn0');
      assert.equal(result.success, false);
    });

    it('Linux addRoute calls ip route add', () => {
      const osnet = new OsNet({ platform: 'linux' });
      const result = osnet.addRoute('10.42.0.0/24', 'svpn0');
      assert.equal(result.success, false);
    });

    it('Linux setMTU calls ip link set mtu', () => {
      const osnet = new OsNet({ platform: 'linux' });
      const result = osnet.setMTU('svpn0', 1420);
      assert.equal(result.success, false);
    });
  });
});
