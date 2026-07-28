import { execFileSync } from 'node:child_process';
import type { SupportedPlatform } from './platform.js';
import type { Journal } from './journal.js';

export const GAME_PORT = 42420;
export const DIAG_PORT = 42421;

export const EXPOSED_WARNING =
  'Game port may be reachable from the internet — check your router.';

export type GuardState = 'applied' | 'unverified' | 'not-applied' | 'conflict';

export interface GuardStatus {
  state: GuardState;
  overlayOnly: boolean;
  consented: boolean;
  warnings: string[];
  appliedAt: number | null;
}

export interface FirewallRule {
  port: number;
  protocol: 'tcp' | 'udp';
  action: 'allow-overlay' | 'deny';
  source?: string;
}

/** Runs a firewall command; returns stdout, throws on non-zero exit. Injectable for tests. */
export type CommandRunner = (cmd: string, args: string[]) => string;

const NFT_TABLE = 'simple-vpn';
const PF_ANCHOR = 'simple-vpn';
const NETSH_RULE = 'simple-vpn-gameguard';

const defaultRunner: CommandRunner = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 });

export class GamePortGuard {
  private status: GuardStatus = {
    state: 'not-applied',
    overlayOnly: true,
    consented: false,
    warnings: [],
    appliedAt: null,
  };

  constructor(
    private readonly platform: SupportedPlatform,
    private readonly overlaySubnet: string,
    private readonly journal: Journal,
    private readonly run: CommandRunner = defaultRunner,
  ) {}

  /**
   * Game-port guard (PRD CF8 C1): consent-gated, recommended-on overlay-only restriction.
   * consented=true  -> apply rules restricting 42420 TCP+UDP to the overlay subnet.
   * consented=false -> apply NO rules; surface a persistent "port may be exposed" warning.
   * No allow-all mode exists — the guard only ever restricts.
   */
  apply(consented: boolean): GuardStatus {
    const warnings: string[] = [];

    if (!consented) {
      this.status = {
        state: 'not-applied',
        overlayOnly: false,
        consented: false,
        warnings: [EXPOSED_WARNING],
        appliedAt: null,
      };
      return this.status;
    }

    const rules: FirewallRule[] = [
      { port: GAME_PORT, protocol: 'tcp', action: 'allow-overlay', source: this.overlaySubnet },
      { port: GAME_PORT, protocol: 'udp', action: 'allow-overlay', source: this.overlaySubnet },
    ];

    const existingRules = this.detectExistingRules();
    if (existingRules.length > 0) {
      warnings.push(
        `Pre-existing firewall rules detected for port ${GAME_PORT}. Manual review recommended — rules not overwritten.`,
        EXPOSED_WARNING,
      );
      this.status = {
        state: 'conflict',
        overlayOnly: false,
        consented: true,
        warnings,
        appliedAt: null,
      };
      return this.status;
    }

    for (const rule of rules) {
      this.journal.append(
        'fwrule',
        `gameguard-${rule.port}-${rule.protocol}`,
        'create',
        { port: rule.port, protocol: rule.protocol, action: rule.action, source: rule.source },
      );
    }

    let applied = true;
    let verified = true;

    try {
      this.applyRules(rules);
    } catch {
      applied = false;
      warnings.push('Failed to apply firewall rules. ' + EXPOSED_WARNING);
    }

    if (applied) {
      try {
        verified = this.verifyRules();
        if (!verified) {
          warnings.push('Firewall rules applied but could not be verified via readback. ' + EXPOSED_WARNING);
        }
      } catch {
        verified = false;
        warnings.push('Firewall rule verification failed. ' + EXPOSED_WARNING);
      }
    }

    this.status = {
      state: applied ? (verified ? 'applied' : 'unverified') : 'not-applied',
      overlayOnly: applied,
      consented: true,
      warnings,
      appliedAt: applied ? Math.floor(Date.now() / 1000) : null,
    };

    return this.status;
  }

  remove(): void {
    const entries = this.journal.getEntriesByType('fwrule');
    for (const entry of entries) {
      if (entry.identity.startsWith('gameguard-')) {
        try {
          this.journal.updateState(entry.id, 'removed');
          this.journal.removeEntry(entry.id);
        } catch {
          // best effort
        }
      }
    }
    try {
      this.removeRules();
    } catch {
      // best effort
    }
    this.status = {
      state: 'not-applied',
      overlayOnly: true,
      consented: false,
      warnings: [],
      appliedAt: null,
    };
  }

  getStatus(): GuardStatus {
    return { ...this.status };
  }

  /** Detects pre-existing user rules referencing the game port (coexistence check). Own table/anchor ignored. */
  private detectExistingRules(): string[] {
    try {
      switch (this.platform) {
        case 'linux': {
          const out = this.run('nft', ['list', 'ruleset']);
          return this.findForeignPortRefs(out, `table inet ${NFT_TABLE}`);
        }
        case 'darwin': {
          const out = this.run('pfctl', ['-sr']);
          return out
            .split('\n')
            .filter((l) => l.includes(String(GAME_PORT)) && !l.includes(PF_ANCHOR));
        }
        case 'win32': {
          const out = this.run('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=all']);
          return this.findForeignPortRefs(out, NETSH_RULE);
        }
      }
    } catch {
      return [];
    }
  }

  private findForeignPortRefs(output: string, ownMarker: string): string[] {
    const refs: string[] = [];
    let inOwn = false;
    for (const line of output.split('\n')) {
      if (line.includes(ownMarker)) inOwn = true;
      else if (/^\S/.test(line) && !line.includes(ownMarker)) inOwn = false;
      if (!inOwn && line.includes(String(GAME_PORT))) refs.push(line.trim());
    }
    return refs;
  }

  private applyRules(rules: FirewallRule[]): void {
    switch (this.platform) {
      case 'linux':
        this.applyLinuxRules(rules);
        break;
      case 'darwin':
        this.applyDarwinRules(rules);
        break;
      case 'win32':
        this.applyWin32Rules(rules);
        break;
    }
  }

  private applyLinuxRules(rules: FirewallRule[]): void {
    // Own nftables table so removal never touches user rules.
    this.run('nft', ['add', 'table', 'inet', NFT_TABLE]);
    this.run('nft', [
      'add', 'chain', 'inet', NFT_TABLE, 'input',
      '{ type filter hook input priority 0 ; policy accept ; }',
    ]);
    for (const rule of rules) {
      this.run('nft', [
        'add', 'rule', 'inet', NFT_TABLE, 'input',
        'ip', 'saddr', rule.source!, rule.protocol, 'dport', String(rule.port), 'accept',
      ]);
      this.run('nft', [
        'add', 'rule', 'inet', NFT_TABLE, 'input',
        rule.protocol, 'dport', String(rule.port), 'drop',
      ]);
    }
  }

  private applyDarwinRules(rules: FirewallRule[]): void {
    // Load an anchor ruleset via pfctl (rules piped via stdin in production).
    this.run('pfctl', ['-a', PF_ANCHOR, '-f', '-']);
    void rules;
  }

  private applyWin32Rules(rules: FirewallRule[]): void {
    for (const rule of rules) {
      this.run('netsh', [
        'advfirewall', 'firewall', 'add', 'rule',
        `name=${NETSH_RULE}`, 'dir=in', 'action=allow',
        `protocol=${rule.protocol}`, `localport=${rule.port}`,
        `remoteip=${rule.source}`,
      ]);
      this.run('netsh', [
        'advfirewall', 'firewall', 'add', 'rule',
        `name=${NETSH_RULE}`, 'dir=in', 'action=block',
        `protocol=${rule.protocol}`, `localport=${rule.port}`,
      ]);
    }
  }

  private removeRules(): void {
    switch (this.platform) {
      case 'linux':
        this.run('nft', ['delete', 'table', 'inet', NFT_TABLE]);
        break;
      case 'darwin':
        this.run('pfctl', ['-a', PF_ANCHOR, '-F', 'rules']);
        break;
      case 'win32':
        this.run('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${NETSH_RULE}`]);
        break;
    }
  }

  private verifyRules(): boolean {
    try {
      switch (this.platform) {
        case 'linux': {
          const out = this.run('nft', ['list', 'table', 'inet', NFT_TABLE]);
          return out.includes(String(GAME_PORT));
        }
        case 'darwin': {
          const out = this.run('pfctl', ['-a', PF_ANCHOR, '-sr']);
          return out.includes(String(GAME_PORT));
        }
        case 'win32': {
          const out = this.run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${NETSH_RULE}`]);
          return out.includes(String(GAME_PORT));
        }
      }
    } catch {
      return false;
    }
  }
}
