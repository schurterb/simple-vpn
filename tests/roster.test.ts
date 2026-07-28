import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSignedRoster,
  verifySignedRoster,
  encodeRoster,
  decodeRoster,
  validateRosterPayload,
  compileRoster,
  CompileError,
  checkRosterSize,
  formatEndpoint,
  RosterTooLargeError,
  MAX_ROSTER_SIZE,
  type RosterPayload,
  type PeerSpec,
} from '../src/roster.js';
import { generateEd25519KeyPair, generateX25519KeyPair, toBase64url } from '../src/crypto.js';

const anchorSigKeys = generateEd25519KeyPair();
const anchorWgKeys = generateX25519KeyPair();
const player1WgKeys = generateX25519KeyPair();
const player1SigKeys = generateEd25519KeyPair();
const player2WgKeys = generateX25519KeyPair();
const player2SigKeys = generateEd25519KeyPair();

const anchorWgPub = toBase64url(anchorWgKeys.publicKey);
const anchorSigPub = toBase64url(anchorSigKeys.publicKey);
const p1WgPub = toBase64url(player1WgKeys.publicKey);
const p2WgPub = toBase64url(player2WgKeys.publicKey);
const p1SigPub = toBase64url(player1SigKeys.publicKey);
const p2SigPub = toBase64url(player2SigKeys.publicKey);

function makePeerSpec(
  name: string,
  wgPub: string,
  sigPub: string,
  overlayIP: string,
  opts: Partial<PeerSpec> = {},
): PeerSpec {
  return {
    name,
    wgPubkey: wgPub,
    sigPubkey: sigPub,
    overlayIP,
    endpoints: [],
    inviteID: `inv-${name}`,
    addedAt: Math.floor(Date.now() / 1000),
    disabled: false,
    listenerEnabled: false,
    ...opts,
  };
}

function makeRoster(overrides: Partial<RosterPayload> = {}): RosterPayload {
  return {
    v: 1,
    rosterVersion: 1,
    netID: 'test-net',
    anchor: {
      name: 'anchor',
      wgPubkey: anchorWgPub,
      overlayIP: '10.42.0.1',
      endpoint: { host: '203.0.113.1', port: 51820 },
      sigPubkey: anchorSigPub,
    },
    subnetCIDR: '10.42.0.0/24',
    members: [
      makePeerSpec('p1', p1WgPub, p1SigPub, '10.42.0.2'),
      makePeerSpec('p2', p2WgPub, p2SigPub, '10.42.0.3'),
    ],
    signedAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe('roster', () => {
  describe('createSignedRoster + verifySignedRoster', () => {
    it('creates and verifies valid roster', () => {
      const payload = makeRoster();
      const roster = createSignedRoster(payload, anchorSigKeys.privateKey);
      assert.equal(verifySignedRoster(roster, anchorSigKeys.publicKey), true);
    });

    it('rejects roster signed by wrong key', () => {
      const wrongKeys = generateEd25519KeyPair();
      const payload = makeRoster();
      const roster = createSignedRoster(payload, wrongKeys.privateKey);
      assert.equal(verifySignedRoster(roster, anchorSigKeys.publicKey), false);
    });

    it('rejects tampered roster', () => {
      const payload = makeRoster();
      const roster = createSignedRoster(payload, anchorSigKeys.privateKey);
      roster.payload.rosterVersion = 999;
      assert.equal(verifySignedRoster(roster, anchorSigKeys.publicKey), false);
    });
  });

  describe('encodeRoster + decodeRoster', () => {
    it('round-trips', () => {
      const payload = makeRoster();
      const roster = createSignedRoster(payload, anchorSigKeys.privateKey);
      const encoded = encodeRoster(roster);
      const decoded = decodeRoster(encoded);
      assert.deepEqual(decoded, roster);
    });
  });

  describe('validateRosterPayload', () => {
    it('accepts valid payload', () => {
      const errors = validateRosterPayload(makeRoster());
      assert.equal(errors.length, 0);
    });

    it('rejects wrong version', () => {
      const errors = validateRosterPayload(makeRoster({ v: 2 as unknown as 1 }));
      assert.ok(errors.some((e) => e.field === 'v'));
    });

    it('rejects non-positive rosterVersion', () => {
      const errors = validateRosterPayload(makeRoster({ rosterVersion: 0 }));
      assert.ok(errors.some((e) => e.field === 'rosterVersion'));
    });

    it('rejects non-integer rosterVersion', () => {
      const errors = validateRosterPayload(makeRoster({ rosterVersion: 1.5 }));
      assert.ok(errors.some((e) => e.field === 'rosterVersion'));
    });

    it('rejects non-object', () => {
      const errors = validateRosterPayload('not an object');
      assert.equal(errors.length, 1);
    });

    it('rejects >10 members', () => {
      const members = Array.from({ length: 11 }, (_, i) =>
        makePeerSpec(`p${i}`, toBase64url(generateX25519KeyPair().publicKey), toBase64url(generateEd25519KeyPair().publicKey), `10.42.0.${i + 10}`),
      );
      const errors = validateRosterPayload(makeRoster({ members }));
      assert.ok(errors.some((e) => e.field === 'members'));
    });

    it('rejects duplicate overlay IPs', () => {
      const errors = validateRosterPayload(makeRoster({
        members: [
          makePeerSpec('p1', p1WgPub, p1SigPub, '10.42.0.2'),
          makePeerSpec('p2', p2WgPub, p2SigPub, '10.42.0.2'),
        ],
      }));
      assert.ok(errors.some((e) => e.field === 'members[1].overlayIP'));
    });
  });

  describe('compileRoster', () => {
    it('compiles for anchor role — all members as peers', () => {
      const payload = makeRoster();
      const compiled = compileRoster(payload, {
        localRole: 'anchor',
        localWgPubkey: anchorWgPub,
        localOverlayIP: '10.42.0.1',
        listenPort: 51820,
        isLocalListener: true,
      });
      assert.equal(compiled.peers.length, 2);
      assert.equal(compiled.peers[0]!.name, 'p1');
      assert.equal(compiled.peers[1]!.name, 'p2');
      assert.equal(compiled.listenPort, 51820);
    });

    it('compiles for member role — anchor as peer with subnet CIDR', () => {
      const payload = makeRoster();
      const compiled = compileRoster(payload, {
        localRole: 'member',
        localWgPubkey: p1WgPub,
        localOverlayIP: '10.42.0.2',
        listenPort: null,
        isLocalListener: false,
      });
      assert.ok(compiled.peers.some((p) => p.name === 'anchor'));
      const anchorPeer = compiled.peers.find((p) => p.name === 'anchor')!;
      assert.ok(anchorPeer.config.allowedIPs.includes('10.42.0.0/24'));
    });

    it('skip non-listener peer when self is non-listener (semi-mesh)', () => {
      const payload = makeRoster();
      const compiled = compileRoster(payload, {
        localRole: 'member',
        localWgPubkey: p1WgPub,
        localOverlayIP: '10.42.0.2',
        listenPort: null,
        isLocalListener: false,
      });
      assert.ok(compiled.peers.some((p) => p.name === 'anchor'));
      assert.ok(!compiled.peers.some((p) => p.name === 'p2'));
    });

    it('includes non-listener peer when self is listener (semi-mesh)', () => {
      const payload = makeRoster();
      const compiled = compileRoster(payload, {
        localRole: 'member',
        localWgPubkey: p1WgPub,
        localOverlayIP: '10.42.0.2',
        listenPort: 51820,
        isLocalListener: true,
      });
      assert.ok(compiled.peers.some((p) => p.name === 'p2'));
    });

    it('sets /32 allowedIPs for anchor-to-member', () => {
      const payload = makeRoster();
      const compiled = compileRoster(payload, {
        localRole: 'anchor',
        localWgPubkey: anchorWgPub,
        localOverlayIP: '10.42.0.1',
        listenPort: 51820,
        isLocalListener: true,
      });
      assert.ok(compiled.peers.every((p) => p.config.allowedIPs[0]!.endsWith('/32')));
    });

    it('sets keepalive for non-listener peers', () => {
      const payload = makeRoster();
      const compiled = compileRoster(payload, {
        localRole: 'anchor',
        localWgPubkey: anchorWgPub,
        localOverlayIP: '10.42.0.1',
        listenPort: 51820,
        isLocalListener: true,
      });
      const p1 = compiled.peers.find((p) => p.name === 'p1')!;
      assert.equal(p1.config.persistentKeepaliveInterval, 25);
    });

    it('omits keepalive for listener-enabled peers', () => {
      const payload = makeRoster({
        members: [
          makePeerSpec('p1', p1WgPub, p1SigPub, '10.42.0.2', { listenerEnabled: true, endpoints: [{ host: '1.2.3.4', port: 51820 }] }),
          makePeerSpec('p2', p2WgPub, p2SigPub, '10.42.0.3'),
        ],
      });
      const compiled = compileRoster(payload, {
        localRole: 'anchor',
        localWgPubkey: anchorWgPub,
        localOverlayIP: '10.42.0.1',
        listenPort: 51820,
        isLocalListener: true,
      });
      const p1 = compiled.peers.find((p) => p.name === 'p1')!;
      assert.equal(p1.config.persistentKeepaliveInterval, undefined);
    });

    it('throws on duplicate overlay IP', () => {
      const payload = makeRoster({
        members: [
          makePeerSpec('p1', p1WgPub, p1SigPub, '10.42.0.2'),
          makePeerSpec('p2', p2WgPub, p2SigPub, '10.42.0.2'),
        ],
      });
      assert.throws(
        () => compileRoster(payload, { localRole: 'anchor', localWgPubkey: anchorWgPub, localOverlayIP: '10.42.0.1', listenPort: 51820, isLocalListener: true }),
        CompileError,
      );
    });

    it('throws on duplicate WireGuard pubkey', () => {
      const payload = makeRoster({
        members: [
          makePeerSpec('p1', p1WgPub, p1SigPub, '10.42.0.2'),
          makePeerSpec('p2', p1WgPub, p2SigPub, '10.42.0.3'),
        ],
      });
      assert.throws(
        () => compileRoster(payload, { localRole: 'anchor', localWgPubkey: anchorWgPub, localOverlayIP: '10.42.0.1', listenPort: 51820, isLocalListener: true }),
        CompileError,
      );
    });

    it('throws when local node not in roster', () => {
      const unknownKeys = generateX25519KeyPair();
      const payload = makeRoster();
      assert.throws(
        () => compileRoster(payload, { localRole: 'member', localWgPubkey: toBase64url(unknownKeys.publicKey), localOverlayIP: '10.42.0.99', listenPort: null, isLocalListener: false }),
        CompileError,
      );
    });

    it('brackets an IPv6 anchor endpoint in the compiled peer config', () => {
      const payload = makeRoster({
        anchor: {
          name: 'anchor', wgPubkey: anchorWgPub, overlayIP: '10.42.0.1',
          endpoint: { host: '2001:db8::1', port: 51820, family: 6 }, sigPubkey: anchorSigPub,
        },
      });
      const compiled = compileRoster(payload, {
        localRole: 'member', localWgPubkey: p1WgPub, localOverlayIP: '10.42.0.2',
        listenPort: null, isLocalListener: false,
      });
      const anchorPeer = compiled.peers.find((p) => p.name === 'anchor')!;
      assert.equal(anchorPeer.config.endpoint, '[2001:db8::1]:51820');
    });
  });

  describe('formatEndpoint', () => {
    it('leaves IPv4 unbracketed', () => {
      assert.equal(formatEndpoint({ host: '203.0.113.1', port: 51820 }), '203.0.113.1:51820');
    });
    it('brackets IPv6', () => {
      assert.equal(formatEndpoint({ host: 'fe80::1', port: 51820, family: 6 }), '[fe80::1]:51820');
    });
  });

  describe('roster size cap (F14)', () => {
    it('accepts a normal roster', () => {
      const encoded = encodeRoster(createSignedRoster(makeRoster(), anchorSigKeys.privateKey));
      assert.equal(checkRosterSize(encoded), true);
    });

    it('rejects decoding an oversized roster', () => {
      const huge = 'A'.repeat(MAX_ROSTER_SIZE + 10);
      assert.throws(() => decodeRoster(huge), RosterTooLargeError);
    });
  });
});
