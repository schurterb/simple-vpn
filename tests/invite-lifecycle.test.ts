import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  InviteLifecycle,
  InviteConflictError,
  InviteLimitError,
  MAX_PENDING,
  QUARANTINE_SEC,
  PRUNE_AFTER_SEC,
  IDEMPOTENCY_TTL_SEC,
} from '../src/invite-lifecycle.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('InviteLifecycle', () => {
  let dir: string;
  let statePath: string;
  let clock: number;
  let lc: InviteLifecycle;

  const now = () => clock;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'svpn-invlc-'));
    statePath = join(dir, 'invites.json');
    clock = 1_000_000;
    lc = new InviteLifecycle(statePath, '10.42.0.0/24', '10.42.0.1', now);
    lc.load();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('IP allocation', () => {
    it('allocates sequentially from .2, skipping the anchor', () => {
      const a = lc.createInvite('p1');
      const b = lc.createInvite('p2');
      assert.equal(a.assignedIP, '10.42.0.2');
      assert.equal(b.assignedIP, '10.42.0.3');
    });

    it('reuses the lowest freed IP only after quarantine expires', () => {
      const a = lc.createInvite('p1'); // .2
      lc.createInvite('p2'); // .3
      lc.revoke(a.inviteID); // frees .2 into quarantine
      const c = lc.createInvite('p3');
      assert.equal(c.assignedIP, '10.42.0.4', 'quarantined .2 not reused yet');

      clock += QUARANTINE_SEC + 1;
      const d = lc.createInvite('p4');
      assert.equal(d.assignedIP, '10.42.0.2', '.2 reusable after quarantine');
    });
  });

  describe('state machine', () => {
    it('consumes a pending invite by digest', () => {
      const rec = lc.createInvite('p1');
      lc.bindDigest(rec.inviteID, 'digestA');
      const consumed = lc.consumeByDigest('digestA');
      assert.equal(consumed.state, 'consumed');
      assert.ok(consumed.consumedAt);
    });

    it('rejects duplicate consume with conflict (409)', () => {
      const rec = lc.createInvite('p1');
      lc.bindDigest(rec.inviteID, 'digestA');
      lc.consumeByDigest('digestA');
      assert.throws(() => lc.consumeByDigest('digestA'), InviteConflictError);
    });

    it('revoke frees the IP and blocks later consume', () => {
      const rec = lc.createInvite('p1');
      lc.bindDigest(rec.inviteID, 'digestA');
      lc.revoke(rec.inviteID);
      assert.equal(lc.get(rec.inviteID)!.state, 'revoked');
      assert.throws(() => lc.consumeByDigest('digestA'), InviteConflictError);
    });

    it('expires pending invites past TTL', () => {
      const rec = lc.createInvite('p1', 100);
      clock += 101;
      lc.expireDue();
      assert.equal(lc.get(rec.inviteID)!.state, 'expired');
    });
  });

  describe('capacity bounds', () => {
    it('enforces max pending invites', () => {
      for (let i = 0; i < MAX_PENDING; i++) lc.createInvite(`p${i}`);
      assert.throws(() => lc.createInvite('overflow'), InviteLimitError);
    });

    it('enforces max invites per hour', () => {
      // Consume as we go so pending stays low; rate limit should still trip.
      for (let i = 0; i < 10; i++) {
        const rec = lc.createInvite(`p${i}`);
        lc.bindDigest(rec.inviteID, `d${i}`);
        lc.consumeByDigest(`d${i}`);
      }
      assert.throws(() => lc.createInvite('rate'), InviteLimitError);
    });
  });

  describe('prune', () => {
    it('removes terminal records after 30 days', () => {
      const rec = lc.createInvite('p1');
      lc.bindDigest(rec.inviteID, 'd');
      lc.consumeByDigest('d');
      clock += PRUNE_AFTER_SEC + 1;
      const removed = lc.prune();
      assert.equal(removed, 1);
      assert.equal(lc.get(rec.inviteID), null);
    });

    it('retains pending records regardless of age', () => {
      const rec = lc.createInvite('p1', 10 * PRUNE_AFTER_SEC);
      clock += PRUNE_AFTER_SEC + 1;
      lc.prune();
      assert.ok(lc.get(rec.inviteID));
    });
  });

  describe('idempotency', () => {
    it('miss then replay for same key+body', () => {
      assert.deepEqual(lc.checkIdempotency('k1', 'h1'), { kind: 'miss' });
      lc.storeIdempotency('k1', 'h1', { inviteID: 'x' });
      const r = lc.checkIdempotency('k1', 'h1');
      assert.equal(r.kind, 'replay');
    });

    it('mismatch when body differs for same key', () => {
      lc.storeIdempotency('k1', 'h1', { inviteID: 'x' });
      assert.deepEqual(lc.checkIdempotency('k1', 'h2'), { kind: 'mismatch' });
    });

    it('expires after TTL', () => {
      lc.storeIdempotency('k1', 'h1', { inviteID: 'x' });
      clock += IDEMPOTENCY_TTL_SEC + 1;
      assert.deepEqual(lc.checkIdempotency('k1', 'h1'), { kind: 'miss' });
    });
  });

  describe('persistence', () => {
    it('survives reload', () => {
      const rec = lc.createInvite('p1');
      lc.bindDigest(rec.inviteID, 'd');
      const lc2 = new InviteLifecycle(statePath, '10.42.0.0/24', '10.42.0.1', now);
      lc2.load();
      const loaded = lc2.get(rec.inviteID);
      assert.ok(loaded);
      assert.equal(loaded!.assignedIP, '10.42.0.2');
      assert.equal(loaded!.inviteDigest, 'd');
    });
  });
});
