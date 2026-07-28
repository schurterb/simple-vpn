import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/journal.js';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Journal', () => {
  let dir: string;
  let journalPath: string;
  let journal: Journal;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'svpn-journal-'));
    journalPath = join(dir, 'journal.jsonl');
    journal = new Journal(journalPath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('returns empty array when file does not exist', () => {
      const entries = journal.load();
      assert.equal(entries.length, 0);
    });

    it('loads entries from disk', () => {
      journal.append('iface', 'svpn0', 'create', { name: 'svpn0' });
      journal.append('route', '10.42.0.0/24', 'create', { dest: '10.42.0.0/24' });

      const journal2 = new Journal(journalPath);
      const entries = journal2.load();
      assert.equal(entries.length, 2);
      assert.equal(entries[0]!.resourceType, 'iface');
      assert.equal(entries[1]!.resourceType, 'route');
    });

    it('skips corrupt lines', () => {
      writeFileSync(journalPath, '{"valid":true}\nnot json\n{"id":"abc","resourceType":"iface","identity":"svpn0","action":"create","attributes":{},"state":"intended","createdAt":1,"updatedAt":1}\n');
      const entries = journal.load();
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.identity, 'svpn0');
    });
  });

  describe('append', () => {
    it('creates entry with unique id', () => {
      journal.load();
      const entry = journal.append('iface', 'svpn0', 'create', { name: 'svpn0' });
      assert.ok(entry.id.length > 0);
      assert.equal(entry.resourceType, 'iface');
      assert.equal(entry.identity, 'svpn0');
      assert.equal(entry.action, 'create');
      assert.equal(entry.state, 'intended');
    });

    it('persists to disk immediately', () => {
      journal.load();
      journal.append('iface', 'svpn0', 'create', { name: 'svpn0' });
      assert.equal(existsSync(journalPath), true);
      const raw = readFileSync(journalPath, 'utf-8');
      assert.ok(raw.includes('svpn0'));
    });

    it('generates unique ids for multiple entries', () => {
      journal.load();
      const e1 = journal.append('iface', 'svpn0', 'create', {});
      const e2 = journal.append('route', '10.42.0.0/24', 'create', {});
      assert.notEqual(e1.id, e2.id);
    });
  });

  describe('updateState', () => {
    it('updates state and persists', () => {
      journal.load();
      const entry = journal.append('iface', 'svpn0', 'create', {});
      journal.updateState(entry.id, 'created');

      const journal2 = new Journal(journalPath);
      journal2.load();
      const entries = journal2.getAllEntries();
      const found = entries.find((e) => e.id === entry.id);
      assert.equal(found!.state, 'created');
    });

    it('throws on unknown id', () => {
      journal.load();
      assert.throws(() => journal.updateState('nonexistent', 'created'), /not found/);
    });
  });

  describe('getActiveEntries', () => {
    it('returns only intended and created entries', () => {
      journal.load();
      const e1 = journal.append('iface', 'svpn0', 'create', {});
      const e2 = journal.append('route', '10.42.0.0/24', 'create', {});
      journal.updateState(e2.id, 'removed');
      journal.removeEntry(e2.id);

      const active = journal.getActiveEntries();
      assert.equal(active.length, 1);
      assert.equal(active[0]!.id, e1.id);
    });
  });

  describe('getEntriesByType', () => {
    it('filters by resource type', () => {
      journal.load();
      journal.append('iface', 'svpn0', 'create', {});
      journal.append('route', '10.42.0.0/24', 'create', {});
      journal.append('fwrule', 'gameguard', 'create', {});

      const ifaces = journal.getEntriesByType('iface');
      assert.equal(ifaces.length, 1);
      assert.equal(ifaces[0]!.resourceType, 'iface');
    });
  });

  describe('removeEntry', () => {
    it('removes entry from memory and disk', () => {
      journal.load();
      const entry = journal.append('iface', 'svpn0', 'create', {});
      journal.removeEntry(entry.id);
      assert.equal(journal.getAllEntries().length, 0);

      const journal2 = new Journal(journalPath);
      journal2.load();
      assert.equal(journal2.getAllEntries().length, 0);
    });
  });

  describe('isEmpty / clear', () => {
    it('isEmpty returns true when no entries', () => {
      journal.load();
      assert.equal(journal.isEmpty(), true);
    });

    it('isEmpty returns false when entries exist', () => {
      journal.load();
      journal.append('iface', 'svpn0', 'create', {});
      assert.equal(journal.isEmpty(), false);
    });

    it('clear removes all entries', () => {
      journal.load();
      journal.append('iface', 'svpn0', 'create', {});
      journal.append('route', '10.42.0.0/24', 'create', {});
      journal.clear();
      assert.equal(journal.isEmpty(), true);
    });
  });
});
