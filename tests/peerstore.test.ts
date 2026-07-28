import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPeerEntry,
  sortCandidates,
  computePeerState,
  recordHandshakeSuccess,
  recordHandshakeFailure,
  getCurrentCandidate,
  advanceCandidate,
  shouldRetry,
  updateCandidatesFromRoster,
  pruneExpiredCandidates,
  STALE_THRESHOLD_SEC,
  MAX_CONSECUTIVE_FAILURES,
  type EndpointCandidate,
  type PeerEntry,
} from '../src/peerstore.js';

function makeCandidate(
  host: string,
  port: number,
  type: 'wan' | 'lan' = 'wan',
  source: 'invite' | 'roster' | 'manual' | 'fallback' = 'roster',
): EndpointCandidate {
  return { host, port, type, source, lastSeen: Date.now() };
}

function makePeer(overrides: Partial<PeerEntry> = {}): PeerEntry {
  return {
    publicKey: 'test-pubkey',
    name: 'test-peer',
    overlayIP: '10.42.0.2',
    candidates: [makeCandidate('1.2.3.4', 51820)],
    currentCandidateIdx: 0,
    state: 'stale',
    lastHandshakeTime: 0,
    lastAttemptTime: 0,
    consecutiveFailures: 0,
    backoffMs: 1000,
    ...overrides,
  };
}

describe('peerstore', () => {
  describe('sortCandidates', () => {
    it('puts WAN before LAN', () => {
      const candidates = [
        makeCandidate('192.168.1.1', 51820, 'lan'),
        makeCandidate('1.2.3.4', 51820, 'wan'),
      ];
      const sorted = sortCandidates(candidates);
      assert.equal(sorted[0]!.type, 'wan');
      assert.equal(sorted[1]!.type, 'lan');
    });

    it('puts fallback candidates last', () => {
      const candidates = [
        makeCandidate('old.example.com', 51820, 'wan', 'fallback'),
        makeCandidate('new.example.com', 51820, 'wan', 'roster'),
      ];
      const sorted = sortCandidates(candidates);
      assert.equal(sorted[0]!.source, 'roster');
      assert.equal(sorted[1]!.source, 'fallback');
    });

    it('deduplicates by host:port', () => {
      const candidates = [
        makeCandidate('1.2.3.4', 51820, 'wan', 'roster'),
        makeCandidate('1.2.3.4', 51820, 'wan', 'invite'),
      ];
      const sorted = sortCandidates(candidates);
      assert.equal(sorted.length, 1);
    });

    it('filters expired candidates', () => {
      const now = Date.now();
      const candidates = [
        { host: '1.2.3.4', port: 51820, type: 'wan' as const, source: 'roster' as const, lastSeen: now, expiresAt: now - 1000 },
        { host: '5.6.7.8', port: 51820, type: 'wan' as const, source: 'roster' as const, lastSeen: now },
      ];
      const sorted = sortCandidates(candidates);
      assert.equal(sorted.length, 1);
      assert.equal(sorted[0]!.host, '5.6.7.8');
    });
  });

  describe('createPeerEntry', () => {
    it('creates peer with sorted candidates', () => {
      const peer = createPeerEntry('pubkey', 'name', '10.42.0.2', [
        makeCandidate('192.168.1.1', 51820, 'lan'),
        makeCandidate('1.2.3.4', 51820, 'wan'),
      ]);
      assert.equal(peer.candidates[0]!.type, 'wan');
      assert.equal(peer.state, 'stale');
    });
  });

  describe('computePeerState', () => {
    it('returns active when handshake is fresh', () => {
      const peer = makePeer({ lastHandshakeTime: Date.now() - 60_000 });
      assert.equal(computePeerState(peer), 'active');
    });

    it('returns stale when handshake is old but failures low', () => {
      const peer = makePeer({ lastHandshakeTime: Date.now() - (STALE_THRESHOLD_SEC + 10) * 1000 });
      assert.equal(computePeerState(peer), 'stale');
    });

    it('returns unreachable when failures exceed max', () => {
      const peer = makePeer({
        lastHandshakeTime: 0,
        consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
      });
      assert.equal(computePeerState(peer), 'unreachable');
    });

    it('returns stale when no handshake yet and failures low', () => {
      const peer = makePeer({ lastHandshakeTime: 0, consecutiveFailures: 1 });
      assert.equal(computePeerState(peer), 'stale');
    });
  });

  describe('recordHandshakeSuccess', () => {
    it('sets state to active and resets failures', () => {
      const peer = makePeer({ consecutiveFailures: 3, backoffMs: 8000, state: 'stale' });
      recordHandshakeSuccess(peer);
      assert.equal(peer.state, 'active');
      assert.equal(peer.consecutiveFailures, 0);
      assert.equal(peer.backoffMs, 10_000);
      assert.ok(peer.lastHandshakeTime > 0);
    });
  });

  describe('recordHandshakeFailure', () => {
    it('increments failures and backoff', () => {
      const peer = makePeer({ consecutiveFailures: 1, backoffMs: 10_000 });
      recordHandshakeFailure(peer);
      assert.equal(peer.consecutiveFailures, 2);
      assert.equal(peer.backoffMs, 20_000);
    });

    it('caps backoff at max', () => {
      const peer = makePeer({ consecutiveFailures: 1, backoffMs: 60_000 });
      recordHandshakeFailure(peer);
      assert.equal(peer.backoffMs, 60_000);
    });

    it('transitions to unreachable after max failures', () => {
      const peer = makePeer({
        consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1,
        lastHandshakeTime: 0,
      });
      recordHandshakeFailure(peer);
      assert.equal(peer.state, 'unreachable');
    });
  });

  describe('getCurrentCandidate / advanceCandidate', () => {
    it('returns first candidate', () => {
      const peer = makePeer({
        candidates: [makeCandidate('1.1.1.1', 1), makeCandidate('2.2.2.2', 2)],
      });
      const c = getCurrentCandidate(peer);
      assert.equal(c!.host, '1.1.1.1');
    });

    it('advances to next candidate', () => {
      const peer = makePeer({
        candidates: [makeCandidate('1.1.1.1', 1), makeCandidate('2.2.2.2', 2)],
      });
      advanceCandidate(peer);
      assert.equal(getCurrentCandidate(peer)!.host, '2.2.2.2');
    });

    it('wraps around to first candidate', () => {
      const peer = makePeer({
        candidates: [makeCandidate('1.1.1.1', 1), makeCandidate('2.2.2.2', 2)],
        currentCandidateIdx: 1,
      });
      advanceCandidate(peer);
      assert.equal(getCurrentCandidate(peer)!.host, '1.1.1.1');
    });

    it('returns null when no candidates', () => {
      const peer = makePeer({ candidates: [] });
      assert.equal(getCurrentCandidate(peer), null);
    });
  });

  describe('shouldRetry', () => {
    it('returns false when active', () => {
      const peer = makePeer({ state: 'active' });
      assert.equal(shouldRetry(peer), false);
    });

    it('returns true when backoff elapsed', () => {
      const peer = makePeer({
        state: 'stale',
        lastAttemptTime: Date.now() - 20_000,
        backoffMs: 10_000,
      });
      assert.equal(shouldRetry(peer), true);
    });

    it('returns false when backoff not elapsed', () => {
      const peer = makePeer({
        state: 'stale',
        lastAttemptTime: Date.now() - 500,
        backoffMs: 50_000,
      });
      assert.equal(shouldRetry(peer), false);
    });
  });

  describe('updateCandidatesFromRoster', () => {
    it('replaces candidates and keeps old as fallback', () => {
      const peer = makePeer({
        candidates: [makeCandidate('old.example.com', 51820)],
      });
      updateCandidatesFromRoster(peer, [makeCandidate('new.example.com', 51820)]);

      assert.ok(peer.candidates.some((c) => c.host === 'new.example.com'));
      assert.ok(peer.candidates.some((c) => c.host === 'old.example.com' && c.source === 'fallback'));
      assert.equal(peer.currentCandidateIdx, 0);
    });

    it('fallback candidates have expiry', () => {
      const peer = makePeer({
        candidates: [makeCandidate('old.example.com', 51820)],
      });
      updateCandidatesFromRoster(peer, [makeCandidate('new.example.com', 51820)]);

      const fallback = peer.candidates.find((c) => c.source === 'fallback');
      assert.ok(fallback!.expiresAt);
      assert.ok(fallback!.expiresAt! > Date.now());
    });
  });

  describe('pruneExpiredCandidates', () => {
    it('removes expired candidates', () => {
      const now = Date.now();
      const peer = makePeer({
        candidates: [
          { host: 'expired.com', port: 51820, type: 'wan', source: 'fallback', lastSeen: now, expiresAt: now - 1000 },
          { host: 'active.com', port: 51820, type: 'wan', source: 'roster', lastSeen: now },
        ],
      });
      pruneExpiredCandidates(peer);
      assert.equal(peer.candidates.length, 1);
      assert.equal(peer.candidates[0]!.host, 'active.com');
    });

    it('resets candidate index if out of bounds', () => {
      const now = Date.now();
      const peer = makePeer({
        candidates: [
          { host: 'expired.com', port: 51820, type: 'wan', source: 'fallback', lastSeen: now, expiresAt: now - 1000 },
        ],
        currentCandidateIdx: 5,
      });
      pruneExpiredCandidates(peer);
      assert.equal(peer.currentCandidateIdx, 0);
    });
  });
});
