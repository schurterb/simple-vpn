import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/journal.js';
import { runRecoverySweep, type ResourceChecker, type ResourceCheckerRegistry } from '../src/recovery.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function createMockChecker(
  resources: Map<string, Record<string, unknown>>,
): ResourceChecker {
  return {
    exists(identity: string): boolean {
      return resources.has(identity);
    },
    matches(identity: string, attributes: Record<string, unknown>): boolean {
      const r = resources.get(identity);
      if (!r) return false;
      return JSON.stringify(r) === JSON.stringify(attributes);
    },
    remove(identity: string): void {
      if (!resources.has(identity)) throw new Error(`Resource ${identity} not found`);
      resources.delete(identity);
    },
  };
}

describe('recovery sweep', () => {
  let dir: string;
  let journalPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'svpn-recovery-'));
    journalPath = join(dir, 'journal.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes matching journaled resources', () => {
    const resources = new Map<string, Record<string, unknown>>();
    resources.set('svpn0', { name: 'svpn0', type: 'tun' });
    resources.set('10.42.0.0/24', { dest: '10.42.0.0/24', dev: 'svpn0' });

    const checkers: ResourceCheckerRegistry = {
      iface: createMockChecker(resources),
      route: createMockChecker(resources),
    };

    const journal = new Journal(journalPath);
    journal.load();
    journal.append('iface', 'svpn0', 'create', { name: 'svpn0', type: 'tun' });
    journal.append('route', '10.42.0.0/24', 'create', { dest: '10.42.0.0/24', dev: 'svpn0' });

    const result = runRecoverySweep(journal, checkers);

    assert.equal(result.removed.length, 2);
    assert.equal(result.warnings.length, 0);
    assert.equal(resources.size, 0);
    assert.equal(journal.isEmpty(), true);
  });

  it('skips resources that no longer exist', () => {
    const resources = new Map<string, Record<string, unknown>>();

    const checkers: ResourceCheckerRegistry = {
      iface: createMockChecker(resources),
    };

    const journal = new Journal(journalPath);
    journal.load();
    journal.append('iface', 'svpn0', 'create', { name: 'svpn0' });

    const result = runRecoverySweep(journal, checkers);

    assert.equal(result.removed.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(journal.isEmpty(), true);
  });

  it('warns on attribute mismatch (fail closed)', () => {
    const resources = new Map<string, Record<string, unknown>>();
    resources.set('svpn0', { name: 'svpn0', type: 'changed' });

    const checkers: ResourceCheckerRegistry = {
      iface: createMockChecker(resources),
    };

    const journal = new Journal(journalPath);
    journal.load();
    journal.append('iface', 'svpn0', 'create', { name: 'svpn0', type: 'tun' });

    const result = runRecoverySweep(journal, checkers);

    assert.equal(result.removed.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0]!.includes('svpn0'));
    assert.equal(resources.size, 1);
  });

  it('warns when no checker registered for resource type', () => {
    const journal = new Journal(journalPath);
    journal.load();
    journal.append('mapping', 'upnp-51820', 'create', { port: 51820 });

    const result = runRecoverySweep(journal, {});

    assert.equal(result.removed.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0]!.includes('mapping'));
  });

  it('is idempotent — running twice produces same result', () => {
    const resources = new Map<string, Record<string, unknown>>();
    resources.set('svpn0', { name: 'svpn0' });

    const checkers: ResourceCheckerRegistry = {
      iface: createMockChecker(resources),
    };

    const journal = new Journal(journalPath);
    journal.load();
    journal.append('iface', 'svpn0', 'create', { name: 'svpn0' });

    const result1 = runRecoverySweep(journal, checkers);
    assert.equal(result1.removed.length, 1);

    const result2 = runRecoverySweep(journal, checkers);
    assert.equal(result2.removed.length, 0);
    assert.equal(result2.skipped.length, 0);
  });

  it('handles mixed scenario: some removed, some skipped, some warned', () => {
    const resources = new Map<string, Record<string, unknown>>();
    resources.set('svpn0', { name: 'svpn0', type: 'tun' });
    resources.set('gameguard', { chain: 'simple-vpn', modified: true });

    const checkers: ResourceCheckerRegistry = {
      iface: createMockChecker(resources),
      fwrule: createMockChecker(resources),
    };

    const journal = new Journal(journalPath);
    journal.load();
    journal.append('iface', 'svpn0', 'create', { name: 'svpn0', type: 'tun' });
    journal.append('route', '10.42.0.0/24', 'create', { dest: '10.42.0.0/24' });
    journal.append('fwrule', 'gameguard', 'create', { chain: 'simple-vpn', modified: false });

    const result = runRecoverySweep(journal, checkers);

    assert.equal(result.removed.length, 1);
    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings.some((w) => w.includes('route')));
    assert.ok(result.warnings.some((w) => w.includes('gameguard')));
  });
});
