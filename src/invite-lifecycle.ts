import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeJsonAtomically, readJsonFile } from './atomic-io.js';
import { ipInCidr } from './invite.js';

export type InviteState = 'pending' | 'consumed' | 'revoked' | 'expired';

export interface InviteRecord {
  inviteID: string;
  inviteDigest: string;
  playerName: string;
  assignedIP: string;
  state: InviteState;
  issuedAt: number;
  expiresAt: number;
  consumedAt?: number;
}

interface QuarantineEntry {
  ip: string;
  until: number; // epoch seconds
}

interface IdempotencyEntry {
  key: string;
  bodyHash: string;
  response: unknown;
  expiresAt: number; // epoch seconds
}

interface PersistShape {
  invites: InviteRecord[];
  quarantine: QuarantineEntry[];
  idempotency: IdempotencyEntry[];
}

export const MAX_PENDING = 5;
export const MAX_INVITES_PER_HOUR = 10;
export const QUARANTINE_SEC = 24 * 3600;
export const IDEMPOTENCY_TTL_SEC = 24 * 3600;
export const PRUNE_AFTER_SEC = 30 * 24 * 3600;
export const DEFAULT_INVITE_TTL_SEC = 72 * 3600;

export class InviteConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteConflictError';
  }
}
export class InviteLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteLimitError';
  }
}
export class IpExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpExhaustedError';
  }
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}
function intToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

export type IdempotencyResult =
  | { kind: 'miss' }
  | { kind: 'replay'; response: unknown }
  | { kind: 'mismatch' };

/**
 * Anchor-side invite lifecycle store (PRD CF3).
 * - Sequential collision-free IP allocation from the overlay subnet (anchor = .1, members from .2).
 * - Persisted state machine: pending -> consumed | revoked | expired (write-ahead, atomic snapshot).
 * - Released IPs are quarantined 24h before reuse; records pruned 30 days after terminal state.
 * - Capacity bounds: <=5 pending, <=10 issued/hour. Idempotency-Key store (24h) for create.
 */
export class InviteLifecycle {
  private invites = new Map<string, InviteRecord>();
  private quarantine: QuarantineEntry[] = [];
  private idempotency = new Map<string, IdempotencyEntry>();

  constructor(
    private readonly statePath: string,
    private readonly subnetCIDR: string,
    private readonly anchorIP: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  load(): void {
    this.invites.clear();
    this.quarantine = [];
    this.idempotency.clear();
    if (!existsSync(this.statePath)) return;
    const data = readJsonFile<PersistShape>(this.statePath);
    for (const inv of data.invites ?? []) this.invites.set(inv.inviteID, inv);
    this.quarantine = data.quarantine ?? [];
    for (const e of data.idempotency ?? []) this.idempotency.set(e.key, e);
  }

  private persist(): void {
    const data: PersistShape = {
      invites: [...this.invites.values()],
      quarantine: this.quarantine,
      idempotency: [...this.idempotency.values()],
    };
    writeJsonAtomically(this.statePath, data);
  }

  list(): InviteRecord[] {
    return [...this.invites.values()].sort((a, b) => a.issuedAt - b.issuedAt);
  }

  get(inviteID: string): InviteRecord | null {
    return this.invites.get(inviteID) ?? null;
  }

  private usedIPs(): Set<string> {
    const used = new Set<string>([this.anchorIP]);
    for (const inv of this.invites.values()) {
      if (inv.state === 'pending' || inv.state === 'consumed') used.add(inv.assignedIP);
    }
    return used;
  }

  private quarantinedIPs(now: number): Set<string> {
    return new Set(this.quarantine.filter((q) => q.until > now).map((q) => q.ip));
  }

  /** Lowest free host address in the subnet, skipping anchor, active, and quarantined IPs. */
  allocateIP(now: number = this.now()): string {
    const [base, prefixRaw] = this.subnetCIDR.split('/');
    const prefix = Number(prefixRaw);
    const baseInt = ipToInt(base!) & ((prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0));
    const hostCount = 2 ** (32 - prefix);
    const firstHost = baseInt + 2; // .0 network, .1 anchor
    const lastHost = baseInt + hostCount - 2; // exclude broadcast
    const used = this.usedIPs();
    const quarantined = this.quarantinedIPs(now);
    for (let n = firstHost; n <= lastHost; n++) {
      const ip = intToIp(n);
      if (used.has(ip) || quarantined.has(ip)) continue;
      if (!ipInCidr(ip, this.subnetCIDR)) continue;
      return ip;
    }
    throw new IpExhaustedError('No free overlay IP available in subnet');
  }

  private countPending(): number {
    let c = 0;
    for (const inv of this.invites.values()) if (inv.state === 'pending') c++;
    return c;
  }

  private countIssuedLastHour(now: number): number {
    let c = 0;
    for (const inv of this.invites.values()) if (now - inv.issuedAt < 3600) c++;
    return c;
  }

  /**
   * Create a pending invite record with a freshly allocated IP.
   * The caller signs the invite (using assignedIP/inviteID/expiresAt) then calls bindDigest().
   */
  createInvite(playerName: string, ttlSec: number = DEFAULT_INVITE_TTL_SEC): InviteRecord {
    const now = this.now();
    this.expireDue(now);
    if (this.countPending() >= MAX_PENDING) {
      throw new InviteLimitError(`At most ${MAX_PENDING} pending invites allowed`);
    }
    if (this.countIssuedLastHour(now) >= MAX_INVITES_PER_HOUR) {
      throw new InviteLimitError(`At most ${MAX_INVITES_PER_HOUR} invites per hour allowed`);
    }
    const assignedIP = this.allocateIP(now);
    const record: InviteRecord = {
      inviteID: randomBytes(12).toString('hex'),
      inviteDigest: '',
      playerName,
      assignedIP,
      state: 'pending',
      issuedAt: now,
      expiresAt: now + ttlSec,
    };
    this.invites.set(record.inviteID, record);
    this.persist();
    return record;
  }

  bindDigest(inviteID: string, inviteDigest: string): void {
    const rec = this.invites.get(inviteID);
    if (!rec) throw new InviteConflictError('Invite not found');
    rec.inviteDigest = inviteDigest;
    this.persist();
  }

  /**
   * Atomically consume the pending invite matching inviteDigest.
   * Duplicate/concurrent reply for a consumed invite -> InviteConflictError (HTTP 409).
   */
  consumeByDigest(inviteDigest: string): InviteRecord {
    const now = this.now();
    this.expireDue(now);
    const rec = [...this.invites.values()].find((r) => r.inviteDigest === inviteDigest);
    if (!rec) throw new InviteConflictError('No invite matches this reply');
    if (rec.state === 'consumed') throw new InviteConflictError('Invite already consumed');
    if (rec.state !== 'pending') throw new InviteConflictError(`Invite is ${rec.state}`);
    rec.state = 'consumed';
    rec.consumedAt = now;
    this.persist();
    return rec;
  }

  revoke(inviteID: string): InviteRecord {
    const rec = this.invites.get(inviteID);
    if (!rec) throw new InviteConflictError('Invite not found');
    if (rec.state !== 'pending') throw new InviteConflictError(`Cannot revoke a ${rec.state} invite`);
    rec.state = 'revoked';
    this.releaseIP(rec.assignedIP, this.now());
    this.persist();
    return rec;
  }

  /** Transition any pending invites past their expiry to 'expired' and quarantine their IPs. */
  expireDue(now: number = this.now()): void {
    let changed = false;
    for (const rec of this.invites.values()) {
      if (rec.state === 'pending' && now >= rec.expiresAt) {
        rec.state = 'expired';
        this.releaseIP(rec.assignedIP, now);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private releaseIP(ip: string, now: number): void {
    this.quarantine = this.quarantine.filter((q) => q.until > now && q.ip !== ip);
    this.quarantine.push({ ip, until: now + QUARANTINE_SEC });
  }

  /** Remove terminal-state records older than the 30-day retention window. */
  prune(now: number = this.now()): number {
    let removed = 0;
    for (const [id, rec] of this.invites) {
      if (rec.state === 'pending') continue;
      const terminalAt = rec.consumedAt ?? rec.expiresAt;
      if (now - terminalAt >= PRUNE_AFTER_SEC) {
        this.invites.delete(id);
        removed++;
      }
    }
    this.quarantine = this.quarantine.filter((q) => q.until > now);
    if (removed > 0) this.persist();
    return removed;
  }

  // ---- Idempotency-Key store (PRD: key + body-hash stored 24h; replay returns original response) ----

  checkIdempotency(key: string, bodyHash: string): IdempotencyResult {
    const now = this.now();
    const entry = this.idempotency.get(key);
    if (!entry || entry.expiresAt <= now) return { kind: 'miss' };
    if (entry.bodyHash !== bodyHash) return { kind: 'mismatch' };
    return { kind: 'replay', response: entry.response };
  }

  storeIdempotency(key: string, bodyHash: string, response: unknown): void {
    const now = this.now();
    this.idempotency.set(key, { key, bodyHash, response, expiresAt: now + IDEMPOTENCY_TTL_SEC });
    this.persist();
  }
}
