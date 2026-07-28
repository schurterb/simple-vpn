import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Reconciler, type ReconcilerOptions } from '../src/reconciler.js';
import type { CompiledState } from '../src/roster.js';
import type { WgInterfaceConfig, WgInterfaceStatus } from '../src/wg-uapi.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeCompiledState(peers: Array<{ publicKey: string; endpoint?: string; allowedIPs: string[]; persistentKeepaliveInterval?: number }>): CompiledState {
  return {
    selfOverlayIP: '10.42.0.1',
    selfWgPubkey: 'self-pubkey',
    listenPort: 51820,
    subnetCIDR: '10.42.0.0/24',
    peers: peers.map((p) => ({
      name: p.publicKey,
      config: {
        publicKey: p.publicKey,
        ...(p.endpoint !== undefined ? { endpoint: p.endpoint } : {}),
        allowedIPs: p.allowedIPs,
        ...(p.persistentKeepaliveInterval !== undefined ? { persistentKeepaliveInterval: p.persistentKeepaliveInterval } : {}),
      },
      overlayIP: p.allowedIPs[0]!.replace('/32', ''),
      isSelf: false,
      isListener: false,
    })),
  };
}

describe('Reconciler', () => {
  let setConfigCalls: WgInterfaceConfig[];
  let setConfigShouldFail: boolean;
  let deviceStatus: WgInterfaceStatus;

  function makeOpts(): ReconcilerOptions {
    setConfigCalls = [];
    setConfigShouldFail = false;
    deviceStatus = { publicKey: 'self-pubkey', listenPort: 51820, peers: [] };
    return {
      privateKey: 'test-privkey',
      listenPort: 51820,
      setConfig: async (config: WgInterfaceConfig) => {
        setConfigCalls.push(config);
        if (setConfigShouldFail) throw new Error('UAPI set failed');
        // Reflect applied config as live device state (for drift diffing).
        deviceStatus = {
          publicKey: 'self-pubkey',
          listenPort: 51820,
          peers: config.peers.map((p) => ({
            publicKey: p.publicKey,
            endpoint: p.endpoint ?? null,
            allowedIPs: p.allowedIPs,
            lastHandshakeTimeSec: 0,
            rxBytes: 0,
            txBytes: 0,
            persistentKeepaliveInterval: 0,
          })),
        };
      },
      getStatus: async (): Promise<WgInterfaceStatus> => deviceStatus,
    };
  }

  it('applies new peers when none exist', async () => {
    const reconciler = new Reconciler(makeOpts());
    const state = makeCompiledState([
      { publicKey: 'peerA', allowedIPs: ['10.42.0.2/32'] },
      { publicKey: 'peerB', allowedIPs: ['10.42.0.3/32'] },
    ]);

    const result = await reconciler.reconcile(state);

    assert.equal(result.applied, true);
    assert.equal(result.addedPeers.length, 2);
    assert.equal(result.removedPeers.length, 0);
    assert.equal(setConfigCalls.length, 1);
    assert.equal(setConfigCalls[0]!.peers.length, 2);
  });

  it('returns no-op when peers unchanged', async () => {
    const opts = makeOpts();
    const reconciler = new Reconciler(opts);
    const state = makeCompiledState([
      { publicKey: 'peerA', allowedIPs: ['10.42.0.2/32'] },
    ]);

    await reconciler.reconcile(state);
    setConfigCalls = [];
    const result = await reconciler.reconcile(state);

    assert.equal(result.applied, false);
    assert.equal(setConfigCalls.length, 0);
  });

  it('removes peers not in desired state', async () => {
    const opts = makeOpts();
    const reconciler = new Reconciler(opts);
    const state1 = makeCompiledState([
      { publicKey: 'peerA', allowedIPs: ['10.42.0.2/32'] },
      { publicKey: 'peerB', allowedIPs: ['10.42.0.3/32'] },
    ]);
    await reconciler.reconcile(state1);

    const state2 = makeCompiledState([
      { publicKey: 'peerA', allowedIPs: ['10.42.0.2/32'] },
    ]);
    const result = await reconciler.reconcile(state2);

    assert.equal(result.applied, true);
    assert.equal(result.removedPeers.length, 1);
    assert.ok(result.removedPeers.includes('peerB'));
    assert.equal(setConfigCalls[setConfigCalls.length - 1]!.peers.length, 1);
  });

  it('rolls back on UAPI failure', async () => {
    const opts = makeOpts();
    const reconciler = new Reconciler(opts);
    const state1 = makeCompiledState([
      { publicKey: 'peerA', allowedIPs: ['10.42.0.2/32'] },
    ]);
    await reconciler.reconcile(state1);

    setConfigShouldFail = true;
    const state2 = makeCompiledState([
      { publicKey: 'peerA', allowedIPs: ['10.42.0.2/32'] },
      { publicKey: 'peerB', allowedIPs: ['10.42.0.3/32'] },
    ]);

    await assert.rejects(reconciler.reconcile(state2), /UAPI set failed/);

    // Should have attempted new config then rolled back
    assert.ok(setConfigCalls.length >= 2);
    // Current generation should still be state1
    const current = reconciler.getCurrentGeneration();
    assert.equal(current!.peers.length, 1);
    assert.equal(current!.peers[0]!.config.publicKey, 'peerA');
  });

  it('serializes concurrent reconcile calls', async () => {
    const opts = makeOpts();
    let callCount = 0;
    opts.setConfig = async (config: WgInterfaceConfig) => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      setConfigCalls.push(config);
    };
    const reconciler = new Reconciler(opts);

    const state1 = makeCompiledState([{ publicKey: 'peerA', allowedIPs: ['10.42.0.2/32'] }]);
    const state2 = makeCompiledState([
      { publicKey: 'peerA', allowedIPs: ['10.42.0.2/32'] },
      { publicKey: 'peerB', allowedIPs: ['10.42.0.3/32'] },
    ]);

    const [r1, r2] = await Promise.all([
      reconciler.reconcile(state1),
      reconciler.reconcile(state2),
    ]);

    assert.equal(r1.applied, true);
    assert.equal(r2.applied, true);
    assert.ok(callCount >= 2);
  });

  it('corrects external device drift', async () => {
    const reconciler = new Reconciler(makeOpts());
    const state = makeCompiledState([
      { publicKey: 'peerA', allowedIPs: ['10.42.0.2/32'] },
    ]);
    await reconciler.reconcile(state);

    // Simulate an externally-added rogue peer on the live device.
    deviceStatus.peers.push({
      publicKey: 'rogue', endpoint: null, allowedIPs: ['10.42.0.99/32'],
      lastHandshakeTimeSec: 0, rxBytes: 0, txBytes: 0, persistentKeepaliveInterval: 0,
    });

    const result = await reconciler.reconcile(state);
    assert.equal(result.applied, true);
    assert.ok(result.removedPeers.includes('rogue'), 'drift peer removed');
  });

  it('persists rosterVersion and reloads it at boot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'svpn-recon-'));
    try {
      const statePath = join(dir, 'generation.json');
      const opts = { ...makeOpts(), statePath };
      const reconciler = new Reconciler(opts);
      const state = makeCompiledState([{ publicKey: 'peerA', allowedIPs: ['10.42.0.2/32'] }]);
      await reconciler.reconcile(state, 7);
      assert.equal(reconciler.getAppliedRosterVersion(), 7);

      const rebooted = new Reconciler({ ...makeOpts(), statePath });
      rebooted.load();
      assert.equal(rebooted.getAppliedRosterVersion(), 7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
