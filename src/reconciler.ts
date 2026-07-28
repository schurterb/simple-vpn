import type { CompiledState } from './roster.js';
import type { WgInterfaceConfig, WgInterfaceStatus, WgPeerConfig } from './wg-uapi.js';
import { existsSync } from 'node:fs';
import { writeJsonAtomically, readJsonFile } from './atomic-io.js';

export interface ReconcilerResult {
  applied: boolean;
  addedPeers: string[];
  removedPeers: string[];
  unchangedPeers: string[];
}

export interface ReconcilerOptions {
  setConfig: (config: WgInterfaceConfig) => Promise<void>;
  getStatus: () => Promise<WgInterfaceStatus>;
  privateKey: string;
  listenPort?: number;
  /** Optional path to persist {rosterVersion, peerPubkeys} for startup re-reconcile + drift detection. */
  statePath?: string;
}

interface PersistedGeneration {
  rosterVersion: number;
  peerPubkeys: string[];
}

export class Reconciler {
  private currentGeneration: CompiledState | null = null;
  private appliedRosterVersion = 0;
  private applying = false;

  constructor(private readonly opts: ReconcilerOptions) {}

  /** Load persisted generation at boot so drift can be detected and re-reconciled. */
  load(): void {
    if (!this.opts.statePath || !existsSync(this.opts.statePath)) return;
    try {
      const state = readJsonFile<PersistedGeneration>(this.opts.statePath);
      this.appliedRosterVersion = state.rosterVersion ?? 0;
    } catch {
      // corrupt state file -> treat as unversioned, forcing a fresh reconcile
      this.appliedRosterVersion = 0;
    }
  }

  getAppliedRosterVersion(): number {
    return this.appliedRosterVersion;
  }

  async reconcile(desired: CompiledState, rosterVersion = 0): Promise<ReconcilerResult> {
    while (this.applying) {
      await sleep(10);
    }
    this.applying = true;

    try {
      // Diff against the LIVE device state so external drift is corrected.
      const current = await this.getCurrentPeerSet();
      const desiredPubkeys = new Set(desired.peers.map((p) => p.config.publicKey));

      const toAdd: CompiledPeer[] = [];
      const toRemove: string[] = [];
      const unchanged: string[] = [];

      for (const peer of desired.peers) {
        if (!current.has(peer.config.publicKey)) {
          toAdd.push(peer);
        } else {
          unchanged.push(peer.config.publicKey);
        }
      }

      for (const pubKey of current) {
        if (!desiredPubkeys.has(pubKey)) {
          toRemove.push(pubKey);
        }
      }

      if (toAdd.length === 0 && toRemove.length === 0) {
        return { applied: false, addedPeers: [], removedPeers: [], unchangedPeers: unchanged };
      }

      const fullConfig = this.buildFullConfig(desired);

      const previousGeneration = this.currentGeneration;

      try {
        await this.opts.setConfig(fullConfig);
        this.currentGeneration = desired;
        this.appliedRosterVersion = rosterVersion;
        this.saveState(desired, rosterVersion);
        return {
          applied: true,
          addedPeers: toAdd.map((p) => p.config.publicKey),
          removedPeers: toRemove,
          unchangedPeers: unchanged,
        };
      } catch (err) {
        if (previousGeneration) {
          const rollbackConfig = this.buildFullConfig(previousGeneration);
          try {
            await this.opts.setConfig(rollbackConfig);
          } catch {
            // best effort rollback
          }
        }
        throw err;
      }
    } finally {
      this.applying = false;
    }
  }

  getCurrentGeneration(): CompiledState | null {
    return this.currentGeneration;
  }

  /** Live device peer set (from UAPI get) so external config drift is detected and corrected. */
  private async getCurrentPeerSet(): Promise<Set<string>> {
    try {
      const status = await this.opts.getStatus();
      return new Set(status.peers.map((p) => p.publicKey));
    } catch {
      // If the device can't be queried, fall back to the last known generation.
      if (!this.currentGeneration) return new Set();
      return new Set(this.currentGeneration.peers.map((p) => p.config.publicKey));
    }
  }

  private saveState(desired: CompiledState, rosterVersion: number): void {
    if (!this.opts.statePath) return;
    try {
      writeJsonAtomically<PersistedGeneration>(this.opts.statePath, {
        rosterVersion,
        peerPubkeys: desired.peers.map((p) => p.config.publicKey),
      });
    } catch {
      // persistence is best-effort; drift detection still works from device state
    }
  }

  private buildFullConfig(state: CompiledState): WgInterfaceConfig {
    const peers: WgPeerConfig[] = state.peers.map((p) => ({
      publicKey: p.config.publicKey,
      ...(p.config.endpoint !== undefined ? { endpoint: p.config.endpoint } : {}),
      allowedIPs: p.config.allowedIPs,
      ...(p.config.persistentKeepaliveInterval !== undefined
        ? { persistentKeepaliveInterval: p.config.persistentKeepaliveInterval }
        : {}),
    }));

    return {
      privateKey: this.opts.privateKey,
      ...(this.opts.listenPort !== undefined ? { listenPort: this.opts.listenPort } : {}),
      peers,
    };
  }
}

import type { CompiledPeer } from './roster.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
