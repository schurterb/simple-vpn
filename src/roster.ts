import { jcsCanonicalize } from './canonical.js';
import { signWithDomainTag, verifyWithDomainTag, toBase64url, fromBase64url, DOMAIN_TAGS } from './crypto.js';
import type { NodeRole, Endpoint } from './config.js';
import type { WgPeerConfig } from './wg-uapi.js';

export interface PeerSpec {
  name: string;
  wgPubkey: string;
  sigPubkey: string;
  overlayIP: string;
  endpoints: Endpoint[];
  inviteID: string;
  addedAt: number;
  disabled: boolean;
  listenerEnabled: boolean;
}

export interface AnchorDescriptor {
  name: string;
  wgPubkey: string;
  overlayIP: string;
  endpoint?: Endpoint;
  sigPubkey?: string;
}

// PRD capacity bound: signed roster document must not exceed 64 KiB on the wire.
export const MAX_ROSTER_SIZE = 64 * 1024;

/** Format an endpoint host:port, bracketing IPv6 literals (M4). */
export function formatEndpoint(ep: Endpoint): string {
  const isV6 = ep.family === 6 || (ep.host.includes(':') && !ep.host.startsWith('['));
  return isV6 ? `[${ep.host}]:${ep.port}` : `${ep.host}:${ep.port}`;
}

export interface RosterPayload {
  v: 1;
  netID: string;
  rosterVersion: number;
  anchor: AnchorDescriptor;
  subnetCIDR: string;
  members: PeerSpec[];
  signedAt: number;
}

export interface SignedRoster {
  payload: RosterPayload;
  signature: string;
}

export function createSignedRoster(
  payload: RosterPayload,
  anchorPrivateKey: Buffer,
): SignedRoster {
  const canonical = jcsCanonicalize(payload);
  const sig = signWithDomainTag(canonical, anchorPrivateKey, DOMAIN_TAGS.roster);
  return { payload, signature: toBase64url(sig) };
}

export function verifySignedRoster(
  roster: SignedRoster,
  anchorPublicKey: Buffer,
): boolean {
  const canonical = jcsCanonicalize(roster.payload);
  const sig = fromBase64url(roster.signature);
  return verifyWithDomainTag(canonical, sig, anchorPublicKey, DOMAIN_TAGS.roster);
}

export function encodeRoster(roster: SignedRoster): string {
  return Buffer.from(JSON.stringify(roster), 'utf-8').toString('base64url');
}

export function checkRosterSize(encoded: string): boolean {
  return Buffer.byteLength(encoded, 'utf-8') <= MAX_ROSTER_SIZE;
}

export function decodeRoster(encoded: string): SignedRoster {
  if (!checkRosterSize(encoded)) {
    throw new RosterTooLargeError(`Roster exceeds ${MAX_ROSTER_SIZE} bytes`);
  }
  const json = Buffer.from(encoded, 'base64url').toString('utf-8');
  return JSON.parse(json) as SignedRoster;
}

export class RosterTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RosterTooLargeError';
  }
}

export interface ValidationError {
  field: string;
  message: string;
}

export function validateRosterPayload(payload: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (typeof payload !== 'object' || payload === null) {
    return [{ field: 'root', message: 'Roster must be an object' }];
  }

  const p = payload as Record<string, unknown>;

  if (p['v'] !== 1) errors.push({ field: 'v', message: 'v must be 1' });
  if (typeof p['rosterVersion'] !== 'number' || !Number.isInteger(p['rosterVersion']) || p['rosterVersion'] < 1) {
    errors.push({ field: 'rosterVersion', message: 'rosterVersion must be a positive integer' });
  }
  if (typeof p['netID'] !== 'string' || p['netID'].length === 0) {
    errors.push({ field: 'netID', message: 'netID must be a non-empty string' });
  }
  if (typeof p['subnetCIDR'] !== 'string') {
    errors.push({ field: 'subnetCIDR', message: 'subnetCIDR must be a string' });
  }
  if (typeof p['signedAt'] !== 'number' || !Number.isInteger(p['signedAt'])) {
    errors.push({ field: 'signedAt', message: 'signedAt must be an integer' });
  }
  if (typeof p['anchor'] !== 'object' || p['anchor'] === null) {
    errors.push({ field: 'anchor', message: 'anchor must be an object' });
  }
  if (!Array.isArray(p['members'])) {
    errors.push({ field: 'members', message: 'members must be an array' });
  }

  if (errors.length > 0) return errors;

  const anchor = p['anchor'] as Record<string, unknown>;
  if (typeof anchor['name'] !== 'string') errors.push({ field: 'anchor.name', message: 'anchor.name must be a string' });
  if (typeof anchor['wgPubkey'] !== 'string') errors.push({ field: 'anchor.wgPubkey', message: 'anchor.wgPubkey must be a string' });
  if (typeof anchor['overlayIP'] !== 'string') errors.push({ field: 'anchor.overlayIP', message: 'anchor.overlayIP must be a string' });

  if (Array.isArray(p['members'])) {
    // VALIDATE[minor] F14 (PRD validation rules): roster <=64 KiB cap not enforced anywhere. fix: size check on decode/accept path.
    if (p['members'].length > 10) {
      errors.push({ field: 'members', message: 'members must be ≤10' });
    }
    const ips = new Set<string>();
    const pubkeys = new Set<string>();
    for (let i = 0; i < p['members'].length; i++) {
      const m = p['members'][i] as Record<string, unknown>;
      if (typeof m['overlayIP'] === 'string' && ips.has(m['overlayIP'])) {
        errors.push({ field: `members[${i}].overlayIP`, message: 'duplicate overlay IP' });
      }
      ips.add(m['overlayIP'] as string);
      if (typeof m['wgPubkey'] === 'string' && pubkeys.has(m['wgPubkey'])) {
        errors.push({ field: `members[${i}].wgPubkey`, message: 'duplicate WG pubkey' });
      }
      pubkeys.add(m['wgPubkey'] as string);
    }
  }

  return errors;
}

export interface CompiledPeer {
  name: string;
  config: WgPeerConfig;
  overlayIP: string;
  isSelf: boolean;
  isListener: boolean;
}

export interface CompiledState {
  selfOverlayIP: string;
  selfWgPubkey: string;
  listenPort: number | null;
  peers: CompiledPeer[];
  subnetCIDR: string;
}

export interface CompileOptions {
  localRole: NodeRole;
  localWgPubkey: string;
  localOverlayIP: string;
  listenPort: number | null;
  isLocalListener: boolean;
}

interface RosterNode {
  name: string;
  wgPubkey: string;
  overlayIP: string;
  endpoints: Endpoint[];
  listenerEnabled: boolean;
  isAnchor: boolean;
}

export function compileRoster(
  roster: RosterPayload,
  opts: CompileOptions,
): CompiledState {
  const allNodes: RosterNode[] = [
    {
      name: roster.anchor.name,
      wgPubkey: roster.anchor.wgPubkey,
      overlayIP: roster.anchor.overlayIP,
      endpoints: roster.anchor.endpoint ? [roster.anchor.endpoint] : [],
      listenerEnabled: true,
      isAnchor: true,
    },
    ...roster.members.map(m => ({
      name: m.name,
      wgPubkey: m.wgPubkey,
      overlayIP: m.overlayIP,
      endpoints: m.endpoints,
      listenerEnabled: m.listenerEnabled,
      isAnchor: false,
    })),
  ];

  const ips = new Set<string>();
  const pubkeys = new Set<string>();

  for (const m of allNodes) {
    if (ips.has(m.overlayIP)) {
      throw new CompileError(`Duplicate overlay IP: ${m.overlayIP}`);
    }
    ips.add(m.overlayIP);
    if (pubkeys.has(m.wgPubkey)) {
      throw new CompileError(`Duplicate WireGuard public key: ${m.wgPubkey}`);
    }
    pubkeys.add(m.wgPubkey);
  }

  const selfEntry = allNodes.find(m => m.wgPubkey === opts.localWgPubkey);
  if (!selfEntry) {
    throw new CompileError('Local node not found in roster');
  }

  const isSelfListener = opts.isLocalListener || selfEntry.isAnchor;
  const peers: CompiledPeer[] = [];

  for (const m of allNodes) {
    if (m.wgPubkey === opts.localWgPubkey) continue;

    const isPeerListener = m.listenerEnabled;
    const tunnelShouldExist = isPeerListener || isSelfListener;

    if (!tunnelShouldExist && !m.isAnchor) {
      continue;
    }

    let allowedIPs: string[];
    if (m.isAnchor) {
      if (selfEntry.isAnchor) {
        allowedIPs = [`${m.overlayIP}/32`];
      } else {
        allowedIPs = [roster.subnetCIDR];
      }
    } else {
      allowedIPs = [`${m.overlayIP}/32`];
    }

    const config: WgPeerConfig = {
      publicKey: m.wgPubkey,
      allowedIPs,
      ...(m.endpoints.length > 0 ? { endpoint: formatEndpoint(m.endpoints[0]!) } : {}),
      ...(!isPeerListener ? { persistentKeepaliveInterval: 25 } : {}),
    };

    peers.push({
      name: m.name,
      config,
      overlayIP: m.overlayIP,
      isSelf: false,
      isListener: isPeerListener,
    });
  }

  return {
    selfOverlayIP: opts.localOverlayIP,
    selfWgPubkey: opts.localWgPubkey,
    listenPort: opts.listenPort,
    peers,
    subnetCIDR: roster.subnetCIDR,
  };
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompileError';
  }
}
