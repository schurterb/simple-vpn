import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore, makeSessionCookie } from '../src/session.js';

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  describe('createSession', () => {
    it('creates session with id and csrf token', () => {
      const session = store.createSession();
      assert.ok(session.id.length > 0);
      assert.ok(session.csrfToken.length > 0);
      assert.notEqual(session.id, session.csrfToken);
    });

    it('creates unique sessions', () => {
      const s1 = store.createSession();
      const s2 = store.createSession();
      assert.notEqual(s1.id, s2.id);
      assert.notEqual(s1.csrfToken, s2.csrfToken);
    });
  });

  describe('getSession', () => {
    it('returns session by id', () => {
      const session = store.createSession();
      const found = store.getSession(session.id);
      assert.ok(found);
      assert.equal(found!.id, session.id);
    });

    it('returns null for unknown id', () => {
      assert.equal(store.getSession('nonexistent'), null);
    });

    it('returns null for empty id', () => {
      assert.equal(store.getSession(''), null);
    });
  });

  describe('validateCsrf', () => {
    it('validates correct token', () => {
      const session = store.createSession();
      assert.equal(store.validateCsrf(session, session.csrfToken), true);
    });

    it('rejects wrong token', () => {
      const session = store.createSession();
      assert.equal(store.validateCsrf(session, 'wrong-token'), false);
    });

    it('rejects empty token', () => {
      const session = store.createSession();
      assert.equal(store.validateCsrf(session, ''), false);
    });
  });

  describe('checkRateLimit', () => {
    it('allows requests under limit', () => {
      const session = store.createSession();
      for (let i = 0; i < 29; i++) {
        assert.equal(store.checkRateLimit(session), true);
      }
    });

    it('blocks requests over limit', () => {
      const session = store.createSession();
      session.requestCount = 29;
      session.rateLimitReset = Date.now() + 1000;
      assert.equal(store.checkRateLimit(session), true);
      assert.equal(store.checkRateLimit(session), false);
    });

    it('resets after window expires', () => {
      const session = store.createSession();
      session.requestCount = 30;
      session.rateLimitReset = Date.now() - 1;
      assert.equal(store.checkRateLimit(session), true);
      assert.equal(session.requestCount, 1);
    });
  });

  describe('SSE slots', () => {
    it('acquires slots up to global max', () => {
      for (let i = 0; i < 10; i++) {
        assert.equal(store.acquireSseSlot(), true);
      }
      assert.equal(store.acquireSseSlot(), false);
    });

    it('releases slots', () => {
      store.acquireSseSlot();
      store.acquireSseSlot();
      store.releaseSseSlot();
      assert.equal(store.acquireSseSlot(), true);
    });

    it('release when no slots held is safe', () => {
      store.releaseSseSlot();
    });
  });

  describe('destroySession', () => {
    it('removes session', () => {
      const session = store.createSession();
      store.destroySession(session.id);
      assert.equal(store.getSession(session.id), null);
    });
  });

  describe('makeSessionCookie', () => {
    it('contains HttpOnly and SameSite=Strict', () => {
      const cookie = makeSessionCookie('test-id');
      assert.ok(cookie.includes('HttpOnly'));
      assert.ok(cookie.includes('SameSite=Strict'));
      assert.ok(cookie.includes('svpn-session=test-id'));
    });
  });
});
