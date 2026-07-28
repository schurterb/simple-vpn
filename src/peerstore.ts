export type EndpointType = 'wan' | 'lan';
export type EndpointSource = 'invite' | 'roster' | 'manual' | 'fallback';

export interface EndpointCandidate {
  host: string;
  port: number;
  family?: 4 | 6;
  type: EndpointType;
  source: EndpointSource;
  lastSeen: number;
  expiresAt?: number;
}

export type PeerState = 'active' | 'stale' | 'unreachable';

export interface PeerEntry {
  publicKey: string;
  name: string;
  overlayIP: string;
  candidates: EndpointCandidate[];
  currentCandidateIdx: number;
  state: PeerState;
  lastHandshakeTime: number;
  lastAttemptTime: number;
  consecutiveFailures: number;
  backoffMs: number;
}

export const STALE_THRESHOLD_SEC = 180;
export const MAX_BACKOFF_MS = 60_000;
export const INITIAL_BACKOFF_MS = 10_000;
// PRD CF5 H2: previous endpoint retained as fallback candidate for 24 h.
export const FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_CONSECUTIVE_FAILURES = 10;

export function createPeerEntry(
  publicKey: string,
  name: string,
  overlayIP: string,
  candidates: EndpointCandidate[],
): PeerEntry {
  const sorted = sortCandidates(candidates);
  return {
    publicKey,
    name,
    overlayIP,
    candidates: sorted,
    currentCandidateIdx: 0,
    state: 'stale',
    lastHandshakeTime: 0,
    lastAttemptTime: 0,
    consecutiveFailures: 0,
    backoffMs: INITIAL_BACKOFF_MS,
  };
}

export function sortCandidates(candidates: EndpointCandidate[]): EndpointCandidate[] {
  const now = Date.now();
  const active = candidates.filter((c) => c.expiresAt === undefined || c.expiresAt > now);
  const wan = active.filter((c) => c.type === 'wan');
  const lan = active.filter((c) => c.type === 'lan');
  const fallback = active.filter((c) => c.source === 'fallback');

  const sorted = [
    ...wan.filter((c) => c.source !== 'fallback'),
    ...lan.filter((c) => c.source !== 'fallback'),
    ...fallback,
  ];

  const seen = new Set<string>();
  return sorted.filter((c) => {
    const key = `${c.host}:${c.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function computePeerState(
  peer: PeerEntry,
  now: number = Date.now(),
): PeerState {
  const handshakeAgeSec = (now - peer.lastHandshakeTime) / 1000;

  if (peer.lastHandshakeTime > 0 && handshakeAgeSec < STALE_THRESHOLD_SEC) {
    return 'active';
  }

  if (peer.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return 'unreachable';
  }

  return 'stale';
}

export function updatePeerState(peer: PeerEntry, now: number = Date.now()): void {
  peer.state = computePeerState(peer, now);
}

export function recordHandshakeSuccess(peer: PeerEntry, now: number = Date.now()): void {
  peer.lastHandshakeTime = now;
  peer.consecutiveFailures = 0;
  peer.backoffMs = INITIAL_BACKOFF_MS;
  peer.state = 'active';
}

export function recordHandshakeFailure(peer: PeerEntry, now: number = Date.now()): void {
  peer.consecutiveFailures++;
  peer.lastAttemptTime = now;
  peer.backoffMs = Math.min(peer.backoffMs * 2, MAX_BACKOFF_MS);
  updatePeerState(peer, now);
}

export function getCurrentCandidate(peer: PeerEntry): EndpointCandidate | null {
  if (peer.candidates.length === 0) return null;
  const idx = peer.currentCandidateIdx % peer.candidates.length;
  return peer.candidates[idx] ?? null;
}

export function advanceCandidate(peer: PeerEntry): EndpointCandidate | null {
  if (peer.candidates.length === 0) return null;
  peer.currentCandidateIdx = (peer.currentCandidateIdx + 1) % peer.candidates.length;
  return getCurrentCandidate(peer);
}

export function shouldRetry(peer: PeerEntry, now: number = Date.now()): boolean {
  if (peer.state === 'active') return false;
  const elapsed = now - peer.lastAttemptTime;
  return elapsed >= peer.backoffMs;
}

export function updateCandidatesFromRoster(
  peer: PeerEntry,
  newCandidates: EndpointCandidate[],
  now: number = Date.now(),
): void {
  const fallbackCandidates = peer.candidates
    .filter((c) => c.source !== 'fallback')
    .map((c) => ({
      ...c,
      source: 'fallback' as const,
      expiresAt: now + FALLBACK_WINDOW_MS,
    }));

  const sorted = sortCandidates([...newCandidates, ...fallbackCandidates]);
  peer.candidates = sorted;
  peer.currentCandidateIdx = 0;
}

export function pruneExpiredCandidates(peer: PeerEntry, now: number = Date.now()): void {
  peer.candidates = peer.candidates.filter(
    (c) => c.expiresAt === undefined || c.expiresAt > now,
  );
  if (peer.currentCandidateIdx >= peer.candidates.length) {
    peer.currentCandidateIdx = 0;
  }
}
