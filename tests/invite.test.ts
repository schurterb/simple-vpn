import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSignedInvite,
  verifySignedInvite,
  createSignedReply,
  verifySignedReply,
  computeInviteDigest,
  encodeInvite,
  decodeInvite,
  encodeReply,
  decodeReply,
  validateInvitePayload,
  validateReplyPayload,
  isInviteExpired,
  checkInviteSize,
  MAX_INVITE_SIZE,
  type InvitePayload,
  type ReplyPayload,
} from '../src/invite.js';
import { generateEd25519KeyPair, generateX25519KeyPair, toBase64url } from '../src/crypto.js';

const anchorKeys = generateEd25519KeyPair();
const anchorWgKeys = generateX25519KeyPair();
const playerKeys = generateEd25519KeyPair();
const playerWgKeys = generateX25519KeyPair();

function makeInvitePayload(overrides: Partial<InvitePayload> = {}): InvitePayload {
  return {
    v: 1,
    netID: 'test-net-001',
    anchorName: 'test-anchor',
    anchorWgPubkey: toBase64url(anchorWgKeys.publicKey),
    anchorSigPubkey: toBase64url(anchorKeys.publicKey),
    endpoints: [{ host: '203.0.113.1', port: 51820, type: 'wan' as const }],
    assignedIP: '10.42.0.2',
    subnetCIDR: '10.42.0.0/24',
    issuedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 72 * 3600,
    inviteID: 'inv-001',
    ...overrides,
  };
}

function makeReplyPayload(inviteDigest: string, overrides: Partial<ReplyPayload> = {}): ReplyPayload {
  return {
    v: 1,
    inviteDigest,
    playerName: 'test-player',
    playerWgPubkey: toBase64url(playerWgKeys.publicKey),
    playerSigPubkey: toBase64url(playerKeys.publicKey),
    ...overrides,
  };
}

describe('invite/reply protocol', () => {
  describe('createSignedInvite + verifySignedInvite', () => {
    it('creates and verifies a valid invite', () => {
      const payload = makeInvitePayload();
      const invite = createSignedInvite(payload, anchorKeys.privateKey);
      assert.equal(verifySignedInvite(invite, anchorKeys.publicKey), true);
    });

    it('rejects invite signed by wrong key', () => {
      const wrongKeys = generateEd25519KeyPair();
      const payload = makeInvitePayload();
      const invite = createSignedInvite(payload, wrongKeys.privateKey);
      assert.equal(verifySignedInvite(invite, anchorKeys.publicKey), false);
    });

    it('rejects tampered invite payload', () => {
      const payload = makeInvitePayload();
      const invite = createSignedInvite(payload, anchorKeys.privateKey);
      invite.payload.assignedIP = '10.42.0.99';
      assert.equal(verifySignedInvite(invite, anchorKeys.publicKey), false);
    });
  });

  describe('encodeInvite + decodeInvite', () => {
    it('round-trips', () => {
      const payload = makeInvitePayload();
      const invite = createSignedInvite(payload, anchorKeys.privateKey);
      const encoded = encodeInvite(invite);
      const decoded = decodeInvite(encoded);
      assert.deepEqual(decoded, invite);
    });

    it('encoded size is within limit', () => {
      const payload = makeInvitePayload();
      const invite = createSignedInvite(payload, anchorKeys.privateKey);
      const encoded = encodeInvite(invite);
      assert.ok(checkInviteSize(encoded), `Invite ${encoded.length} bytes exceeds ${MAX_INVITE_SIZE}`);
    });
  });

  describe('computeInviteDigest', () => {
    it('is deterministic', () => {
      const payload = makeInvitePayload();
      const invite = createSignedInvite(payload, anchorKeys.privateKey);
      const d1 = computeInviteDigest(invite);
      const d2 = computeInviteDigest(invite);
      assert.equal(d1, d2);
    });

    it('differs for different invites', () => {
      const invite1 = createSignedInvite(makeInvitePayload({ inviteID: 'inv-001' }), anchorKeys.privateKey);
      const invite2 = createSignedInvite(makeInvitePayload({ inviteID: 'inv-002' }), anchorKeys.privateKey);
      const d1 = computeInviteDigest(invite1);
      const d2 = computeInviteDigest(invite2);
      assert.notEqual(d1, d2);
    });
  });

  describe('createSignedReply + verifySignedReply', () => {
    it('creates and verifies a valid reply', () => {
      const invite = createSignedInvite(makeInvitePayload(), anchorKeys.privateKey);
      const digest = computeInviteDigest(invite);
      const reply = createSignedReply(makeReplyPayload(digest), playerKeys.privateKey);
      assert.equal(verifySignedReply(reply, playerKeys.publicKey), true);
    });

    it('rejects reply signed by wrong key', () => {
      const invite = createSignedInvite(makeInvitePayload(), anchorKeys.privateKey);
      const digest = computeInviteDigest(invite);
      const wrongKeys = generateEd25519KeyPair();
      const reply = createSignedReply(makeReplyPayload(digest), wrongKeys.privateKey);
      assert.equal(verifySignedReply(reply, playerKeys.publicKey), false);
    });

    it('rejects tampered reply', () => {
      const invite = createSignedInvite(makeInvitePayload(), anchorKeys.privateKey);
      const digest = computeInviteDigest(invite);
      const reply = createSignedReply(makeReplyPayload(digest), playerKeys.privateKey);
      reply.payload.playerName = 'hacker';
      assert.equal(verifySignedReply(reply, playerKeys.publicKey), false);
    });
  });

  describe('encodeReply + decodeReply', () => {
    it('round-trips', () => {
      const invite = createSignedInvite(makeInvitePayload(), anchorKeys.privateKey);
      const digest = computeInviteDigest(invite);
      const reply = createSignedReply(makeReplyPayload(digest), playerKeys.privateKey);
      const encoded = encodeReply(reply);
      const decoded = decodeReply(encoded);
      assert.deepEqual(decoded, reply);
    });
  });

  describe('validateInvitePayload', () => {
    it('accepts valid payload', () => {
      const errors = validateInvitePayload(makeInvitePayload());
      assert.equal(errors.length, 0);
    });

    it('rejects wrong version', () => {
      const errors = validateInvitePayload(makeInvitePayload({ v: 2 as unknown as 1 }));
      assert.ok(errors.some((e) => e.includes('v must be 1')));
    });

    it('rejects empty netID', () => {
      const errors = validateInvitePayload(makeInvitePayload({ netID: '' }));
      assert.ok(errors.some((e) => e.includes('netID')));
    });

    it('rejects empty endpoints', () => {
      const errors = validateInvitePayload(makeInvitePayload({ endpoints: [] }));
      assert.ok(errors.some((e) => e.includes('endpoints')));
    });

    it('rejects expiresAt <= issuedAt', () => {
      const now = Math.floor(Date.now() / 1000);
      const errors = validateInvitePayload(makeInvitePayload({ issuedAt: now, expiresAt: now }));
      assert.ok(errors.some((e) => e.includes('expiresAt')));
    });

    it('rejects non-object', () => {
      const errors = validateInvitePayload('not an object');
      assert.equal(errors.length, 1);
    });
    it('rejects invalid endpoint type', () => {
      const errors = validateInvitePayload(makeInvitePayload({ endpoints: [{ host: '1.2.3.4', port: 51820, type: 'invalid' as unknown as 'wan' }] }));
      assert.ok(errors.some((e) => e.includes('type')));
    });

    it('rejects invalid assignedIP', () => {
      const errors = validateInvitePayload(makeInvitePayload({ assignedIP: '999.999.999.999' }));
      assert.ok(errors.some((e) => e.includes('assignedIP')));
    });

    it('rejects invalid base64url key', () => {
      const errors = validateInvitePayload(makeInvitePayload({ anchorWgPubkey: 'not-a-key' }));
      assert.ok(errors.some((e) => e.includes('anchorWgPubkey')));
    });
  });

  describe('validateReplyPayload', () => {
    it('accepts valid payload', () => {
      const errors = validateReplyPayload(makeReplyPayload('somedigest'));
      assert.equal(errors.length, 0);
    });

    it('rejects wrong version', () => {
      const errors = validateReplyPayload(makeReplyPayload('digest', { v: 2 as unknown as 1 }));
      assert.ok(errors.some((e) => e.includes('v must be 1')));
    });

    it('rejects empty inviteDigest', () => {
      const errors = validateReplyPayload(makeReplyPayload(''));
      assert.ok(errors.some((e) => e.includes('inviteDigest')));
    });

    it('rejects non-object', () => {
      const errors = validateReplyPayload(42);
      assert.equal(errors.length, 1);
    });
  });

  describe('isInviteExpired', () => {
    it('returns false for future expiry', () => {
      const payload = makeInvitePayload({ expiresAt: Math.floor(Date.now() / 1000) + 3600 });
      assert.equal(isInviteExpired(payload), false);
    });

    it('returns true for past expiry', () => {
      const payload = makeInvitePayload({ expiresAt: Math.floor(Date.now() / 1000) - 3600 });
      assert.equal(isInviteExpired(payload), true);
    });

    it('returns true for current time', () => {
      const now = Math.floor(Date.now() / 1000);
      const payload = makeInvitePayload({ expiresAt: now });
      assert.equal(isInviteExpired(payload, now), true);
    });
  });

  describe('checkInviteSize', () => {
    it('returns true for small invite', () => {
      assert.equal(checkInviteSize('abc'), true);
    });

    it('returns false for oversized invite', () => {
      const big = 'a'.repeat(MAX_INVITE_SIZE + 1);
      assert.equal(checkInviteSize(big), false);
    });
  });

  describe('digest binding (replay defense)', () => {
    it('reply for invite A does not verify against invite B', () => {
      const inviteA = createSignedInvite(makeInvitePayload({ inviteID: 'A' }), anchorKeys.privateKey);
      const inviteB = createSignedInvite(makeInvitePayload({ inviteID: 'B' }), anchorKeys.privateKey);
      const digestA = computeInviteDigest(inviteA);
      const digestB = computeInviteDigest(inviteB);

      const replyForA = createSignedReply(makeReplyPayload(digestA), playerKeys.privateKey);

      // Reply is valid and correctly signed
      assert.equal(verifySignedReply(replyForA, playerKeys.publicKey), true);
      // But digest doesn't match invite B
      assert.notEqual(replyForA.payload.inviteDigest, digestB);
    });
  });
});
