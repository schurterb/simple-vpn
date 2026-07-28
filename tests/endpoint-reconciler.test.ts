import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EndpointReconciler,
  resolveCandidates,
  isPrivateOrReserved,
  DNS_MAX_RECORDS,
  DNS_TTL_MIN_SEC,
  DNS_TTL_MAX_SEC,
  type DnsResolver,
} from '../src/endpoint-reconciler.js';
import {
  createPeerEntry,
  FALLBACK_WINDOW_MS,
  MAX_CONSECUTIVE_FAILURES,
  type EndpointCandidate,
  type PeerEntry,
} from '../src/peerstore.js';

function cand(host: string, port = 51820): EndpointCandidate {
  return { host, port, type: 'wan', source: 'roster', lastSeen: Date.now() };
}

describe('peerstore fallback window', () => {
  it('is 24 hours (PRD H2)', () => {
    assert.equal(FALLBACK_WINDOW_MS, 24 * 60 * 60 * 1000);
  });
});

describe('isPrivateOrReserved', () => {
  it('flags RFC1918 + loopback + link-local', () => {
    assert.equal(isPrivateOrReserved('10.1.2.3'), true);
    assert.equal(isPrivateOrReserved('172.16.0.1'), true);
    assert.equal(isPrivateOrReserved('192.168.1.1'), true);
    assert.equal(isPrivateOrReserved('127.0.0.1'), true);
    assert.equal(isPrivateOrReserved('169.254.1.1'), true);
  });

  it('allows public addresses', () => {
    assert.equal(isPrivateOrReserved('203.0.113.5'), false);
    assert.equal(isPrivateOrReserved('8.8.8.8'), false);
  });
});

describe('resolveCandidates', () => {
  const resolver: DnsResolver = async (_host, family) => {
    if (family === 4) {
      return [
        { address: '203.0.113.1', ttl: 5 },      // public, ttl below min
        { address: '10.0.0.9', ttl: 100 },        // private -> discarded for WAN
        { address: '198.51.100.2', ttl: 999999 }, // public, ttl above max
      ];
    }
    return [{ address: '2001:db8::1', ttl: 300 }];
  };

  it('discards private results for WAN and clamps TTL', async () => {
    const now = 1_000_000;
    const out = await resolveCandidates('host.example', 51820, 'wan', resolver, now);
    const hosts = out.map((c) => c.host);
    assert.ok(!hosts.includes('10.0.0.9'), 'private discarded for WAN');
    assert.ok(hosts.includes('203.0.113.1'));

    const low = out.find((c) => c.host === '203.0.113.1')!;
    assert.equal(low.expiresAt, now + DNS_TTL_MIN_SEC * 1000, 'ttl clamped to min');
    const high = out.find((c) => c.host === '198.51.100.2')!;
    assert.equal(high.expiresAt, now + DNS_TTL_MAX_SEC * 1000, 'ttl clamped to max');
  });

  it('keeps private results for LAN candidates', async () => {
    const out = await resolveCandidates('host.example', 51820, 'lan', resolver);
    assert.ok(out.map((c) => c.host).includes('10.0.0.9'));
  });

  it('prefers A before AAAA and caps at 8 records', async () => {
    const many: DnsResolver = async (_h, family) =>
      Array.from({ length: 6 }, (_, i) => ({
        address: family === 4 ? `203.0.113.${i}` : `2001:db8::${i}`,
        ttl: 300,
      }));
    const out = await resolveCandidates('h', 51820, 'wan', many);
    assert.equal(out.length, DNS_MAX_RECORDS);
    assert.equal(out[0]!.family, 4, 'A records come first');
  });
});

describe('EndpointReconciler.tick', () => {
  function makePeer(): PeerEntry {
    const p = createPeerEntry('pk', 'peer', '10.42.0.2', [cand('203.0.113.1'), cand('203.0.113.2')]);
    return p;
  }

  it('marks peer active on successful probe and resets failures', async () => {
    const peer = makePeer();
    peer.consecutiveFailures = 3;
    peer.lastAttemptTime = 0;
    const applied: EndpointCandidate[] = [];
    const rec = new EndpointReconciler({
      applyEndpoint: async (_p, c) => { applied.push(c); },
      probe: async () => true,
    });
    const res = await rec.tick(peer);
    assert.equal(res.action, 'active');
    assert.equal(peer.state, 'active');
    assert.equal(peer.consecutiveFailures, 0);
    assert.equal(applied.length, 1);
  });

  it('cycles to next candidate on failed probe', async () => {
    const peer = makePeer();
    peer.lastAttemptTime = 0;
    const rec = new EndpointReconciler({
      applyEndpoint: async () => {},
      probe: async () => false,
    });
    const first = await rec.tick(peer);
    assert.equal(first.action, 'retry');
    assert.equal(first.candidate!.host, '203.0.113.1');
    assert.equal(peer.currentCandidateIdx, 1, 'advanced to next candidate');
  });

  it('transitions to unreachable after 10 consecutive failures', async () => {
    const peer = makePeer();
    const rec = new EndpointReconciler({
      applyEndpoint: async () => {},
      probe: async () => false,
      now: () => Date.now(),
    });
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      peer.lastAttemptTime = 0; // force retry eligibility
      peer.backoffMs = 0;
      await rec.tick(peer);
    }
    assert.equal(peer.state, 'unreachable');
  });

  it('refetches roster once when peer is unreachable', async () => {
    const peer = makePeer();
    peer.state = 'unreachable';
    peer.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
    peer.lastHandshakeTime = 0;
    peer.lastAttemptTime = 0;
    peer.backoffMs = 0;
    let refetches = 0;
    const rec = new EndpointReconciler({
      applyEndpoint: async () => {},
      probe: async () => false,
      refetchRoster: async () => { refetches++; },
    });
    await rec.tick(peer);
    await rec.tick(peer);
    assert.equal(refetches, 1, 'refetch only once until recovery');
  });
});
