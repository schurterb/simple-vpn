import { jcsCanonicalize } from './canonical.js';
import { signWithDomainTag, verifyWithDomainTag, sha256, toBase64url, fromBase64url, DOMAIN_TAGS } from './crypto.js';

export interface InviteEndpoint {
  host: string;
  port: number;
  family?: 4 | 6;
  type: 'wan' | 'lan';
}

export interface InvitePayload {
  v: 1;
  netID: string;
  anchorName: string;
  anchorWgPubkey: string;
  anchorSigPubkey: string;
  endpoints: InviteEndpoint[];
  assignedIP: string;
  subnetCIDR: string;
  issuedAt: number;
  expiresAt: number;
  inviteID: string;
}

export interface SignedInvite {
  payload: InvitePayload;
  signature: string;
}

export interface ReplyPayload {
  v: 1;
  inviteDigest: string;
  playerName: string;
  playerWgPubkey: string;
  playerSigPubkey: string;
}

export interface SignedReply {
  payload: ReplyPayload;
  signature: string;
}

export const MAX_INVITE_SIZE = 1024;

// VALIDATE[major] F11 (PRD CF3): invite lifecycle absent — no InviteRecord persistence, no sequential
// IP allocation (10.42.0.2+, freed-IP 24 h quarantine), no pending->consumed|revoked|expired machine,
// no 409-on-consumed, no 30-day prune, no <=5 pending / <=10 invites-per-hour caps.
// fix: anchor-side invite store with single-writer journaled consume transaction.
export function createSignedInvite(
  payload: InvitePayload,
  anchorPrivateKey: Buffer,
): SignedInvite {
  const canonical = jcsCanonicalize(payload);
  const sig = signWithDomainTag(canonical, anchorPrivateKey, DOMAIN_TAGS.invite);
  return {
    payload,
    signature: toBase64url(sig),
  };
}

export function verifySignedInvite(
  invite: SignedInvite,
  anchorPublicKey: Buffer,
): boolean {
  const canonical = jcsCanonicalize(invite.payload);
  const sig = fromBase64url(invite.signature);
  return verifyWithDomainTag(canonical, sig, anchorPublicKey, DOMAIN_TAGS.invite);
}

export function computeInviteDigest(invite: SignedInvite): string {
  const canonical = jcsCanonicalize(invite.payload);
  const sig = fromBase64url(invite.signature);
  const fullBytes = Buffer.concat([canonical, sig]);
  return toBase64url(sha256(fullBytes));
}

export function createSignedReply(
  payload: ReplyPayload,
  playerPrivateKey: Buffer,
): SignedReply {
  const canonical = jcsCanonicalize(payload);
  const sig = signWithDomainTag(canonical, playerPrivateKey, DOMAIN_TAGS.reply);
  return {
    payload,
    signature: toBase64url(sig),
  };
}

export function verifySignedReply(
  reply: SignedReply,
  playerPublicKey: Buffer,
): boolean {
  const canonical = jcsCanonicalize(reply.payload);
  const sig = fromBase64url(reply.signature);
  return verifyWithDomainTag(canonical, sig, playerPublicKey, DOMAIN_TAGS.reply);
}

export function encodeInvite(invite: SignedInvite): string {
  const json = JSON.stringify(invite);
  return Buffer.from(json, 'utf-8').toString('base64url');
}

export function decodeInvite(encoded: string): SignedInvite {
  const json = Buffer.from(encoded, 'base64url').toString('utf-8');
  const parsed = JSON.parse(json) as SignedInvite;
  return parsed;
}

export function encodeReply(reply: SignedReply): string {
  const json = JSON.stringify(reply);
  return Buffer.from(json, 'utf-8').toString('base64url');
}

export function decodeReply(encoded: string): SignedReply {
  const json = Buffer.from(encoded, 'base64url').toString('utf-8');
  const parsed = JSON.parse(json) as SignedReply;
  return parsed;
}

export function validateInvitePayload(payload: unknown): string[] {
  const errors: string[] = [];

  if (typeof payload !== 'object' || payload === null) {
    return ['payload must be an object'];
  }

  const p = payload as Record<string, unknown>;

  if (p['v'] !== 1) errors.push('v must be 1');
  if (typeof p['netID'] !== 'string' || p['netID'].length === 0) errors.push('netID must be a non-empty string');
  if (typeof p['anchorName'] !== 'string' || !isValidName(p['anchorName'] as string)) errors.push('anchorName must be 1-32 printable chars');
  if (typeof p['anchorWgPubkey'] !== 'string' || !isValidBase64urlKey(p['anchorWgPubkey'] as string)) errors.push('anchorWgPubkey must be a valid base64url 32-byte key');
  if (typeof p['anchorSigPubkey'] !== 'string' || !isValidBase64urlKey(p['anchorSigPubkey'] as string)) errors.push('anchorSigPubkey must be a valid base64url 32-byte key');
  if (!Array.isArray(p['endpoints']) || p['endpoints'].length === 0) errors.push('endpoints must be a non-empty array');
  if (Array.isArray(p['endpoints'])) {
    for (let i = 0; i < p['endpoints'].length; i++) {
      const ep = p['endpoints'][i] as Record<string, unknown>;
      if (typeof ep['host'] !== 'string' || !/^[a-zA-Z0-9.:-]+$/.test(ep['host'])) errors.push(`endpoints[${i}].host must be valid host`);
      if (typeof ep['port'] !== 'number' || ep['port'] < 1 || ep['port'] > 65535) errors.push(`endpoints[${i}].port must be 1-65535`);
      if (ep['type'] !== 'wan' && ep['type'] !== 'lan') errors.push(`endpoints[${i}].type must be 'wan' or 'lan'`);
    }
  }
  const subnetOk = typeof p['subnetCIDR'] === 'string' && isRfc1918Cidr(p['subnetCIDR'] as string);
  if (!subnetOk) errors.push('subnetCIDR must be an RFC1918 CIDR');
  // assignedIP validated against the invite's own subnetCIDR (supports anchor-selectable subnets).
  if (typeof p['assignedIP'] !== 'string' || !isValidIPv4(p['assignedIP'] as string)) {
    errors.push('assignedIP must be a valid IPv4 address');
  } else if (subnetOk && !ipInCidr(p['assignedIP'] as string, p['subnetCIDR'] as string)) {
    errors.push('assignedIP must fall within subnetCIDR');
  }
  if (typeof p['issuedAt'] !== 'number' || !Number.isInteger(p['issuedAt'])) errors.push('issuedAt must be an integer');
  if (typeof p['expiresAt'] !== 'number' || !Number.isInteger(p['expiresAt'])) errors.push('expiresAt must be an integer');
  if (typeof p['inviteID'] !== 'string' || p['inviteID'].length === 0) errors.push('inviteID must be a non-empty string');

  if (typeof p['expiresAt'] === 'number' && typeof p['issuedAt'] === 'number') {
    if (p['expiresAt'] <= p['issuedAt']) errors.push('expiresAt must be after issuedAt');
  }

  return errors;
}

export function validateReplyPayload(payload: unknown): string[] {
  const errors: string[] = [];

  if (typeof payload !== 'object' || payload === null) {
    return ['payload must be an object'];
  }

  const p = payload as Record<string, unknown>;

  if (p['v'] !== 1) errors.push('v must be 1');
  if (typeof p['inviteDigest'] !== 'string' || p['inviteDigest'].length === 0) errors.push('inviteDigest must be a non-empty string');
  if (typeof p['playerName'] !== 'string' || !isValidName(p['playerName'] as string)) errors.push('playerName must be 1-32 printable chars');
  if (typeof p['playerWgPubkey'] !== 'string' || !isValidBase64urlKey(p['playerWgPubkey'] as string)) errors.push('playerWgPubkey must be a valid base64url 32-byte key');
  if (typeof p['playerSigPubkey'] !== 'string' || !isValidBase64urlKey(p['playerSigPubkey'] as string)) errors.push('playerSigPubkey must be a valid base64url 32-byte key');

  return errors;
}

export function isInviteExpired(payload: InvitePayload, now: number = Math.floor(Date.now() / 1000)): boolean {
  return now >= payload.expiresAt;
}

export function checkInviteSize(encoded: string): boolean {
  return Buffer.byteLength(encoded, 'utf-8') <= MAX_INVITE_SIZE;
}

export function isValidIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) <= 255);
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

/** True iff ip falls within the given CIDR block. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, prefixRaw] = cidr.split('/');
  if (!base || prefixRaw === undefined) return false;
  const prefix = Number(prefixRaw);
  if (!isValidIPv4(ip) || !isValidIPv4(base) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(base) & mask);
}

/** RFC1918 ranges only: 10/8, 172.16/12, 192.168/16 (prefix within the range's bounds). */
export function isRfc1918Cidr(cidr: string): boolean {
  const [base, prefixRaw] = cidr.split('/');
  if (!base || prefixRaw === undefined || !isValidIPv4(base)) return false;
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 8 || prefix > 30) return false;
  return (
    ipInCidr(base, '10.0.0.0/8') ||
    ipInCidr(base, '172.16.0.0/12') ||
    ipInCidr(base, '192.168.0.0/16')
  );
}

// Keys are raw 32-byte OKP keys (RFC 8410) encoded base64url -> strictly 32 bytes.
function isValidBase64urlKey(key: string): boolean {
  try {
    const buf = Buffer.from(key, 'base64url');
    return buf.length === 32;
  } catch {
    return false;
  }
}

function isPrintableNoControl(s: string): boolean {
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** Names: 1-32 chars, printable, no control characters (PRD data-model constraint). */
export function isValidName(s: string): boolean {
  return typeof s === 'string' && s.length >= 1 && s.length <= 32 && isPrintableNoControl(s);
}
