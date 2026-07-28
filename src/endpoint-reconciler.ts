import {
  type PeerEntry,
  type EndpointCandidate,
  type EndpointType,
  updatePeerState,
  recordHandshakeSuccess,
  recordHandshakeFailure,
  getCurrentCandidate,
  advanceCandidate,
  shouldRetry,
  updateCandidatesFromRoster,
} from './peerstore.js';

// PRD CF5 endpoint schema / DNS rules (M4).
export const DNS_MAX_RECORDS = 8;
export const DNS_TTL_MIN_SEC = 30;
export const DNS_TTL_MAX_SEC = 24 * 3600;

export interface DnsAnswer {
  address: string;
  ttl: number; // seconds, as returned by the resolver
}

/** Injectable DNS resolver (A for family=4, AAAA for family=6). */
export type DnsResolver = (host: string, family: 4 | 6) => Promise<DnsAnswer[]>;

/** True for RFC1918 / loopback / link-local / reserved IPv4 addresses. */
export function isPrivateOrReserved(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return true; // non-IPv4 literals treated as unsuitable for WAN dialing
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function clampTtl(ttl: number): number {
  if (!Number.isFinite(ttl) || ttl <= 0) return DNS_TTL_MIN_SEC;
  return Math.min(DNS_TTL_MAX_SEC, Math.max(DNS_TTL_MIN_SEC, Math.floor(ttl)));
}

/**
 * Resolve a hostname into endpoint candidates (PRD CF5 M4):
 * A preferred then AAAA, at most 8 records total, TTL clamped to [30 s, 24 h].
 * For WAN candidates, private/reserved results are discarded; LAN keeps them.
 */
export async function resolveCandidates(
  host: string,
  port: number,
  type: EndpointType,
  resolver: DnsResolver,
  now: number = Date.now(),
): Promise<EndpointCandidate[]> {
  const answers: Array<DnsAnswer & { family: 4 | 6 }> = [];
  try {
    const a = await resolver(host, 4);
    for (const r of a) answers.push({ ...r, family: 4 });
  } catch {
    // ignore A failure; try AAAA
  }
  try {
    const aaaa = await resolver(host, 6);
    for (const r of aaaa) answers.push({ ...r, family: 6 });
  } catch {
    // ignore AAAA failure
  }

  const candidates: EndpointCandidate[] = [];
  for (const ans of answers) {
    if (candidates.length >= DNS_MAX_RECORDS) break;
    if (type === 'wan' && ans.family === 4 && isPrivateOrReserved(ans.address)) continue;
    candidates.push({
      host: ans.address,
      port,
      family: ans.family,
      type,
      source: 'roster',
      lastSeen: now,
      expiresAt: now + clampTtl(ans.ttl) * 1000,
    });
  }
  return candidates;
}

export type TickAction = 'active' | 'retry' | 'wait' | 'no-candidate' | 'idle';

export interface TickResult {
  action: TickAction;
  state: PeerEntry['state'];
  candidate: EndpointCandidate | null;
}

export interface EndpointReconcilerOptions {
  /** Apply a candidate endpoint to the WG peer (via UAPI). */
  applyEndpoint: (peer: PeerEntry, candidate: EndpointCandidate) => Promise<void>;
  /** Probe whether a WG handshake is established for this peer. */
  probe: (peer: PeerEntry, candidate: EndpointCandidate) => Promise<boolean>;
  /** Optional: re-fetch the signed roster (e.g. when a peer goes unreachable). */
  refetchRoster?: () => Promise<void>;
  resolver?: DnsResolver;
  now?: () => number;
}

/**
 * Daemon-owned endpoint reconciler (PRD CF5): drives each dialed peer through
 * ACTIVE -> STALE (candidate cycling with backoff) -> UNREACHABLE (10 failed cycles).
 * Endpoint mutations only originate here (DNS re-resolution / roster update / cycling),
 * never from unauthenticated network input.
 */
export class EndpointReconciler {
  private readonly now: () => number;
  private unreachableNotified = new Set<string>();

  constructor(private readonly opts: EndpointReconcilerOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** One reconciliation step for a single peer. */
  async tick(peer: PeerEntry): Promise<TickResult> {
    const now = this.now();
    updatePeerState(peer, now);

    if (peer.state === 'active') {
      this.unreachableNotified.delete(peer.publicKey);
      return { action: 'idle', state: peer.state, candidate: getCurrentCandidate(peer) };
    }

    if (peer.state === 'unreachable' && this.opts.refetchRoster && !this.unreachableNotified.has(peer.publicKey)) {
      this.unreachableNotified.add(peer.publicKey);
      try {
        await this.opts.refetchRoster();
      } catch {
        // best effort
      }
    }

    if (!shouldRetry(peer, now)) {
      return { action: 'wait', state: peer.state, candidate: getCurrentCandidate(peer) };
    }

    const candidate = getCurrentCandidate(peer);
    if (!candidate) {
      recordHandshakeFailure(peer, now);
      return { action: 'no-candidate', state: peer.state, candidate: null };
    }

    await this.opts.applyEndpoint(peer, candidate);
    const ok = await this.opts.probe(peer, candidate);

    if (ok) {
      recordHandshakeSuccess(peer, now);
      return { action: 'active', state: peer.state, candidate };
    }

    recordHandshakeFailure(peer, now);
    advanceCandidate(peer);
    return { action: 'retry', state: peer.state, candidate };
  }

  /** Re-resolve a hostname and merge fresh candidates (old ones kept as 24h fallback). */
  async refreshDns(peer: PeerEntry, host: string, port: number, type: EndpointType): Promise<void> {
    if (!this.opts.resolver) return;
    const now = this.now();
    const fresh = await resolveCandidates(host, port, type, this.opts.resolver, now);
    if (fresh.length > 0) updateCandidatesFromRoster(peer, fresh, now);
  }

  /** Run the driver over a set of peers on an interval. Returns a stop function. */
  run(getPeers: () => PeerEntry[], intervalMs: number): () => void {
    const timer = setInterval(() => {
      for (const peer of getPeers()) {
        void this.tick(peer);
      }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }
}
