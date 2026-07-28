import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ListenerManager } from '../src/listener.js';
import { PortMapper, type NatClient, type PortMapping } from '../src/port-mapper.js';
import { Journal } from '../src/journal.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeMockNatClient(): NatClient {
  const mappings: PortMapping[] = [];
  return {
    getExternalIP: async () => '203.0.113.99',
    addPortMapping: async (m: PortMapping) => { mappings.push(m); },
    deletePortMapping: async (port: number, proto: 'tcp' | 'udp') => {
      const idx = mappings.findIndex((m) => m.externalPort === port && m.protocol === proto);
      if (idx >= 0) mappings.splice(idx, 1);
    },
    getMappings: async () => [...mappings],
  };
}

describe('ListenerManager', () => {
  let dir: string;
  let journal: Journal;
  let mapper: PortMapper;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'svpn-listener-'));
    journal = new Journal(join(dir, 'journal.jsonl'));
    journal.load();
    mapper = new PortMapper(makeMockNatClient(), journal);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const passVerifier = async () => true;
  const failVerifier = async () => false;

  describe('enable', () => {
    it('activates + advertises when reachability verifies (optional role)', async () => {
      const mgr = new ListenerManager(mapper, passVerifier);
      const status = await mgr.enable('optional', '10.42.0.1', 51820, 51820, true);

      assert.equal(status.state, 'active');
      assert.equal(status.verified, true);
      assert.equal(status.advertised, true);
      assert.equal(status.externalIP, '203.0.113.99');
      assert.equal(status.externalPort, 51820);
    });

    it('optional unverified → failed, NOT advertised, mapping rolled back', async () => {
      const nat = makeMockNatClient();
      const rollbackMapper = new PortMapper(nat, journal);
      const mgr = new ListenerManager(rollbackMapper, failVerifier);
      const status = await mgr.enable('optional', '10.42.0.1', 51820, 51820, true);

      assert.equal(status.state, 'failed');
      assert.equal(status.verified, false);
      assert.equal(status.advertised, false);
      assert.ok(status.manualGuide);
      assert.deepEqual(await nat.getMappings(), [], 'mapping rolled back on unverified');
    });

    it('anchor-mandatory unverified → failed, not advertised', async () => {
      const mgr = new ListenerManager(mapper, failVerifier);
      const status = await mgr.enable('anchor-mandatory', '10.42.0.1', 51820, 51820, true);

      assert.equal(status.state, 'failed');
      assert.equal(status.advertised, false);
    });

    it('default verifier is fail-closed (never advertises)', async () => {
      const mgr = new ListenerManager(mapper); // no verifier injected
      const status = await mgr.enable('optional', '10.42.0.1', 51820, 51820, true);
      assert.equal(status.state, 'failed');
      assert.equal(status.advertised, false);
    });

    it('fails when not consented', async () => {
      const mgr = new ListenerManager(mapper, passVerifier);
      const status = await mgr.enable('optional', '10.42.0.1', 51820, 51820, false);

      assert.equal(status.state, 'failed');
      assert.ok(status.manualGuide);
    });

    it('fails on anchor-mandatory when mapping fails', async () => {
      const failingMapper = new PortMapper(
        { ...makeMockNatClient(), getExternalIP: async () => { throw new Error('NAT down'); } },
        journal,
      );
      const mgr = new ListenerManager(failingMapper, passVerifier);
      const status = await mgr.enable('anchor-mandatory', '10.42.0.1', 51820, 51820, true);

      assert.equal(status.state, 'failed');
    });
  });

  describe('disable', () => {
    it('resets status to disabled', async () => {
      const mgr = new ListenerManager(mapper, passVerifier);
      await mgr.enable('optional', '10.42.0.1', 51820, 51820, true);
      await mgr.disable();

      const status = mgr.getStatus();
      assert.equal(status.state, 'disabled');
      assert.equal(status.externalIP, null);
      assert.equal(status.advertised, false);
    });
  });

  describe('shouldRePropose', () => {
    it('returns false when no previous IP', async () => {
      const mgr = new ListenerManager(mapper, passVerifier);
      assert.equal(mgr.shouldRePropose('1.2.3.4'), false);
    });

    it('returns true when IP changes', async () => {
      const mgr = new ListenerManager(mapper, passVerifier);
      await mgr.enable('optional', '10.42.0.1', 51820, 51820, true);
      assert.equal(mgr.shouldRePropose('99.99.99.99'), true);
    });

    it('returns false when IP same', async () => {
      const mgr = new ListenerManager(mapper, passVerifier);
      await mgr.enable('optional', '10.42.0.1', 51820, 51820, true);
      assert.equal(mgr.shouldRePropose('203.0.113.99'), false);
    });
  });
});
