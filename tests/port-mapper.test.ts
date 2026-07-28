import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PortMapper, MAPPING_TAG, type NatClient, type PortMapping } from '../src/port-mapper.js';
import { Journal } from '../src/journal.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeMockNatClient(overrides: Partial<NatClient> = {}): NatClient {
  const mappings: PortMapping[] = [];
  return {
    getExternalIP: async () => '203.0.113.99',
    addPortMapping: async (mapping: PortMapping) => {
      mappings.push(mapping);
    },
    deletePortMapping: async (externalPort: number, protocol: 'tcp' | 'udp') => {
      const idx = mappings.findIndex((m) => m.externalPort === externalPort && m.protocol === protocol);
      if (idx >= 0) mappings.splice(idx, 1);
    },
    getMappings: async () => [...mappings],
    ...overrides,
  };
}

describe('PortMapper', () => {
  let dir: string;
  let journalPath: string;
  let journal: Journal;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'svpn-portmap-'));
    journalPath = join(dir, 'journal.jsonl');
    journal = new Journal(journalPath);
    journal.load();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('mapPort', () => {
    it('creates mapping when consented', async () => {
      const client = makeMockNatClient();
      const mapper = new PortMapper(client, journal);
      const result = await mapper.mapPort('10.42.0.1', 51820, 51820, 'udp', true);

      assert.equal(result.success, true);
      assert.ok(result.mapping);
      assert.equal(result.mapping!.tag, MAPPING_TAG);
      assert.equal(result.externalIP, '203.0.113.99');
      assert.equal(result.manualGuide, null);
    });

    it('returns manual guide when not consented', async () => {
      const client = makeMockNatClient();
      const mapper = new PortMapper(client, journal);
      const result = await mapper.mapPort('10.42.0.1', 51820, 51820, 'udp', false);

      assert.equal(result.success, false);
      assert.ok(result.manualGuide);
      assert.ok(result.manualGuide!.includes('51820'));
    });

    it('rejects foreign mappings on same port', async () => {
      const client = makeMockNatClient({
        getMappings: async () => [
          { externalPort: 51820, internalPort: 12345, protocol: 'udp', internalIP: '192.168.1.5', leaseDurationSec: 3600, tag: 'other-app' },
        ],
      });
      const mapper = new PortMapper(client, journal);
      const result = await mapper.mapPort('10.42.0.1', 51820, 51820, 'udp', true);

      assert.equal(result.success, false);
      assert.ok(result.error.includes('already mapped'));
    });

    it('allows own-tagged mappings on same port', async () => {
      const client = makeMockNatClient({
        getMappings: async () => [
          { externalPort: 51820, internalPort: 51820, protocol: 'udp', internalIP: '10.42.0.1', leaseDurationSec: 3600, tag: MAPPING_TAG },
        ],
      });
      const mapper = new PortMapper(client, journal);
      const result = await mapper.mapPort('10.42.0.1', 51820, 51820, 'udp', true);

      // Should succeed since existing mapping is ours
      assert.equal(result.success, true);
    });

    it('journals mapping creation', async () => {
      const client = makeMockNatClient();
      const mapper = new PortMapper(client, journal);
      await mapper.mapPort('10.42.0.1', 51820, 51820, 'udp', true);

      const entries = journal.getEntriesByType('mapping');
      assert.ok(entries.length > 0);
      assert.ok(entries[0]!.identity.startsWith('upnp-'));
    });

    it('returns error on NAT client failure', async () => {
      const client = makeMockNatClient({
        getExternalIP: async () => { throw new Error('NAT unavailable'); },
      });
      const mapper = new PortMapper(client, journal);
      const result = await mapper.mapPort('10.42.0.1', 51820, 51820, 'udp', true);

      assert.equal(result.success, false);
      assert.ok(result.error.includes('NAT unavailable'));
      assert.ok(result.manualGuide);
    });
  });

  describe('unmapPort', () => {
    it('removes mapping and journal entries', async () => {
      const client = makeMockNatClient();
      const mapper = new PortMapper(client, journal);
      await mapper.mapPort('10.42.0.1', 51820, 51820, 'udp', true);

      await mapper.unmapPort();

      assert.equal(mapper.getCurrentMapping(), null);
      const entries = journal.getEntriesByType('mapping');
      assert.equal(entries.length, 0);
    });

    it('is safe to call when no mapping exists', async () => {
      const client = makeMockNatClient();
      const mapper = new PortMapper(client, journal);
      await mapper.unmapPort();
      assert.equal(mapper.getCurrentMapping(), null);
    });
  });
});
