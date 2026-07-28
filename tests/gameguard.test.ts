import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GamePortGuard, GAME_PORT, EXPOSED_WARNING, type CommandRunner } from '../src/gameguard.js';
import { Journal } from '../src/journal.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('GamePortGuard', () => {
  let dir: string;
  let journalPath: string;
  let journal: Journal;
  let calls: Array<{ cmd: string; args: string[] }>;

  function mockRunner(): CommandRunner {
    return (cmd, args) => {
      calls.push({ cmd, args });
      // Detection reads (no pre-existing foreign rules) -> empty output.
      if (args.includes('ruleset')) return '';                       // linux detect
      if (args.includes('name=all')) return '';                      // win32 detect
      if (args.includes('-sr') && !args.includes('-a')) return '';   // darwin detect
      // Verify readbacks -> output containing the port so 'applied' is reached.
      if (args.includes('table') || args.includes('-sr') || args.includes('show')) {
        return `dport ${GAME_PORT} accept`;
      }
      return '';
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'svpn-guard-'));
    journalPath = join(dir, 'journal.jsonl');
    journal = new Journal(journalPath);
    journal.load();
    calls = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('getStatus', () => {
    it('returns initial not-applied state', () => {
      const guard = new GamePortGuard('linux', '10.42.0.0/24', journal, mockRunner());
      const status = guard.getStatus();
      assert.equal(status.state, 'not-applied');
      assert.equal(status.overlayOnly, true);
      assert.equal(status.consented, false);
      assert.equal(status.appliedAt, null);
    });
  });

  describe('apply — unconsented (no rule, warn)', () => {
    it('applies no rules and surfaces exposure warning', () => {
      const guard = new GamePortGuard('linux', '10.42.0.0/24', journal, mockRunner());
      const status = guard.apply(false);
      assert.equal(status.state, 'not-applied');
      assert.equal(status.overlayOnly, false);
      assert.equal(status.consented, false);
      assert.ok(status.warnings.includes(EXPOSED_WARNING));
      assert.equal(calls.length, 0, 'no firewall commands run without consent');
      assert.equal(journal.getEntriesByType('fwrule').length, 0);
    });
  });

  describe('apply — consented (overlay-only restriction)', () => {
    it('applies restriction, sets overlayOnly + consented', () => {
      const guard = new GamePortGuard('linux', '10.42.0.0/24', journal, mockRunner());
      const status = guard.apply(true);
      assert.equal(status.consented, true);
      assert.equal(status.overlayOnly, true);
      assert.equal(status.state, 'applied');
      assert.ok(status.appliedAt! > 0);
    });

    it('journals both TCP and UDP allow-overlay rules', () => {
      const guard = new GamePortGuard('linux', '10.42.0.0/24', journal, mockRunner());
      guard.apply(true);
      const entries = journal.getEntriesByType('fwrule');
      const tcp = entries.find((e) => e.attributes['protocol'] === 'tcp');
      const udp = entries.find((e) => e.attributes['protocol'] === 'udp');
      assert.ok(tcp && udp);
      assert.equal(tcp!.attributes['action'], 'allow-overlay');
      assert.equal(tcp!.attributes['port'], GAME_PORT);
      assert.equal(udp!.attributes['port'], GAME_PORT);
    });

    it('uses nftables own table on linux (not iptables)', () => {
      const guard = new GamePortGuard('linux', '10.42.0.0/24', journal, mockRunner());
      guard.apply(true);
      assert.ok(calls.some((c) => c.cmd === 'nft' && c.args.includes('table') && c.args.includes('simple-vpn')));
      assert.ok(calls.some((c) => c.cmd === 'nft' && c.args.includes('drop')));
      assert.ok(!calls.some((c) => c.cmd === 'iptables'));
    });

    it('uses pfctl anchor on darwin', () => {
      const guard = new GamePortGuard('darwin', '10.42.0.0/24', journal, mockRunner());
      guard.apply(true);
      assert.ok(calls.some((c) => c.cmd === 'pfctl' && c.args.includes('simple-vpn')));
    });

    it('uses netsh on win32', () => {
      const guard = new GamePortGuard('win32', '10.42.0.0/24', journal, mockRunner());
      guard.apply(true);
      assert.ok(calls.some((c) => c.cmd === 'netsh' && c.args.some((a) => a.includes('simple-vpn-gameguard'))));
    });

    it('reports unverified when readback lacks the port', () => {
      const runner: CommandRunner = (cmd, args) => {
        calls.push({ cmd, args });
        return 'no matching rules';
      };
      const guard = new GamePortGuard('linux', '10.42.0.0/24', journal, runner);
      const status = guard.apply(true);
      assert.equal(status.state, 'unverified');
      assert.ok(status.warnings.some((w) => w.includes(EXPOSED_WARNING)));
    });

    it('reports not-applied when apply throws', () => {
      const runner: CommandRunner = (cmd, args) => {
        calls.push({ cmd, args });
        if (args.includes('ruleset')) return '';
        throw new Error('permission denied');
      };
      const guard = new GamePortGuard('linux', '10.42.0.0/24', journal, runner);
      const status = guard.apply(true);
      assert.equal(status.state, 'not-applied');
      assert.equal(status.overlayOnly, false);
      assert.ok(status.warnings.some((w) => w.includes(EXPOSED_WARNING)));
    });
  });

  describe('coexistence detection', () => {
    it('reports conflict when foreign rule references the port', () => {
      const runner: CommandRunner = (cmd, args) => {
        calls.push({ cmd, args });
        if (args.includes('ruleset')) {
          return `table inet filter {\n  chain input {\n    tcp dport ${GAME_PORT} accept\n  }\n}`;
        }
        return '';
      };
      const guard = new GamePortGuard('linux', '10.42.0.0/24', journal, runner);
      const status = guard.apply(true);
      assert.equal(status.state, 'conflict');
      assert.ok(status.warnings.some((w) => w.includes('Pre-existing')));
    });

    it('ignores rules inside our own table', () => {
      const runner: CommandRunner = (cmd, args) => {
        calls.push({ cmd, args });
        if (args.includes('ruleset')) {
          return `table inet simple-vpn {\n  chain input {\n    tcp dport ${GAME_PORT} drop\n  }\n}`;
        }
        if (args.includes('list')) return `dport ${GAME_PORT} accept`;
        return '';
      };
      const guard = new GamePortGuard('linux', '10.42.0.0/24', journal, runner);
      const status = guard.apply(true);
      assert.notEqual(status.state, 'conflict');
    });
  });

  describe('remove', () => {
    it('resets status and tears down rules', () => {
      const guard = new GamePortGuard('linux', '10.42.0.0/24', journal, mockRunner());
      guard.apply(true);
      calls = [];
      guard.remove();
      const status = guard.getStatus();
      assert.equal(status.state, 'not-applied');
      assert.equal(status.appliedAt, null);
      assert.ok(calls.some((c) => c.cmd === 'nft' && c.args.includes('delete')));
    });
  });
});
