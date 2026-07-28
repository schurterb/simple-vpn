import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApiServer, ApiError, type ApiServices } from '../src/api-server.js';
import { SESSION_COOKIE_NAME, CSRF_HEADER } from '../src/session.js';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function fetchServer(url: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...opts, redirect: 'manual' });
}

function httpRequestRaw(
  port: number,
  path: string,
  method: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, (res: IncomingMessage) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

interface MockServices extends ApiServices {
  calls: Record<string, unknown[]>;
  replyConflict: boolean;
}

function makeMockServices(): MockServices {
  const calls: Record<string, unknown[]> = {};
  const rec = (name: string, ...args: unknown[]) => { (calls[name] ??= []).push(args); };
  return {
    calls,
    replyConflict: false,
    async getStatus() { rec('getStatus'); return { status: 'ok', role: 'anchor', peers: [], guard: {}, listener: {} }; },
    async createInvite(playerName: string) { rec('createInvite', playerName); return { inviteID: 'inv1', invite: 'INVITE_STR', assignedIP: '10.42.0.2' }; },
    async importInvite(invite: string) { rec('importInvite', invite); return { reply: 'REPLY_STR' }; },
    async importReply(reply: string) {
      rec('importReply', reply);
      if (this.replyConflict) throw new ApiError(409, 'CONFLICT', 'Invite already consumed');
      return { member: { name: 'bob' } };
    },
    async revokeInvite(id: string) { rec('revokeInvite', id); },
    async removePeer(key: string) { rec('removePeer', key); },
    async probe() { rec('probe'); return { tunnel: { result: 'green' } }; },
    async setListener(enabled: boolean) { rec('setListener', enabled); return { state: enabled ? 'active' : 'disabled' }; },
    async setGuard(consented: boolean) { rec('setGuard', consented); return { consented }; },
    async getSettings() { rec('getSettings'); return { name: 'node', uiPort: 8080 }; },
    async patchSettings(patch: Record<string, unknown>) { rec('patchSettings', patch); return { ...patch }; },
  };
}

describe('ApiServer', () => {
  let dir: string;
  let server: ApiServer;
  let port: number;
  let baseHost: string;
  let baseUrl: string;
  let services: MockServices;

  async function authSession(): Promise<{ cookie: string; csrf: string }> {
    const bs = await fetchServer(`${baseUrl}/api/bootstrap`, { headers: { Host: baseHost } });
    const data = await bs.json();
    const setCookie = bs.headers.get('set-cookie')!;
    const sessionId = setCookie.match(/svpn-session=([^;]+)/)![1]!;
    return { cookie: `${SESSION_COOKIE_NAME}=${sessionId}`, csrf: data.csrfToken };
  }

  async function api(method: string, path: string, extra: Record<string, string> = {}, body?: unknown): Promise<Response> {
    const { cookie, csrf } = await authSession();
    const headers: Record<string, string> = {
      Host: baseHost,
      'X-Svpn-Api': '1',
      Cookie: cookie,
      [CSRF_HEADER]: csrf,
      'Content-Type': 'application/json',
      ...extra,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetchServer(`${baseUrl}${path}`, init);
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'svpn-api-'));
    const wwwDir = join(dir, 'www');
    mkdirSync(wwwDir, { recursive: true });
    writeFileSync(join(wwwDir, 'index.html'), '<html><body>Test UI</body></html>');
    writeFileSync(join(wwwDir, 'test.js'), 'console.log("test");');

    port = 18420 + Math.floor(Math.random() * 100);
    baseHost = `127.0.0.1:${port}`;
    baseUrl = `http://${baseHost}`;

    services = makeMockServices();
    server = new ApiServer({ port, wwwDir, canonicalHost: baseHost, services });
    await server.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('static file serving', () => {
    it('serves index.html at /', async () => {
      const res = await fetchServer(`${baseUrl}/`, { headers: { Host: baseHost } });
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.ok(text.includes('Test UI'));
    });

    it('serves static JS files', async () => {
      const res = await fetchServer(`${baseUrl}/test.js`, { headers: { Host: baseHost } });
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.ok(text.includes('console.log'));
    });

    it('returns 404 for non-existent files', async () => {
      const res = await fetchServer(`${baseUrl}/nonexistent.html`, { headers: { Host: baseHost } });
      assert.equal(res.status, 404);
    });

    it('blocks path traversal', async () => {
      const res = await fetchServer(`${baseUrl}/../../../etc/passwd`, { headers: { Host: baseHost } });
      assert.ok(res.status === 403 || res.status === 404);
    });

    it('sets no-store cache control', async () => {
      const res = await fetchServer(`${baseUrl}/`, { headers: { Host: baseHost } });
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });

    it('does not emit CORS headers', async () => {
      const res = await fetchServer(`${baseUrl}/`, { headers: { Host: baseHost } });
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    });
  });

  describe('host header validation', () => {
    it('rejects wrong host', async () => {
      const result = await httpRequestRaw(port, '/', 'GET', { Host: 'evil.com' });
      assert.equal(result.status, 403);
    });
  });

  describe('bootstrap endpoint', () => {
    it('returns csrf token and sets cookie', async () => {
      const res = await fetchServer(`${baseUrl}/api/bootstrap`, { headers: { Host: baseHost } });
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.ok(data.csrfToken);
      const cookie = res.headers.get('set-cookie');
      assert.ok(cookie);
      assert.ok(cookie!.includes('svpn-session='));
      assert.ok(cookie!.includes('HttpOnly'));
    });

    it('rejects POST to bootstrap', async () => {
      const res = await fetchServer(`${baseUrl}/api/bootstrap`, {
        method: 'POST',
        headers: { Host: baseHost },
      });
      assert.equal(res.status, 405);
    });
  });

  describe('API authentication', () => {
    it('rejects API call without session cookie', async () => {
      const res = await fetchServer(`${baseUrl}/api/status`, { headers: { Host: baseHost, 'X-Svpn-Api': '1' } });
      assert.equal(res.status, 401);
    });

    it('rejects API call with cookie but no CSRF token', async () => {
      const bsRes = await fetchServer(`${baseUrl}/api/bootstrap`, { headers: { Host: baseHost } });
      const cookie = bsRes.headers.get('set-cookie')!;
      const sessionId = cookie.match(/svpn-session=([^;]+)/)![1];

      const res = await fetchServer(`${baseUrl}/api/status`, {
        headers: {
          'X-Svpn-Api': '1',
          Cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        },
      });
      assert.equal(res.status, 403);
    });

    it('rejects API call with wrong CSRF token', async () => {
      const bsRes = await fetchServer(`${baseUrl}/api/bootstrap`, { headers: { Host: baseHost } });
      const cookie = bsRes.headers.get('set-cookie')!;
      const sessionId = cookie.match(/svpn-session=([^;]+)/)![1];

      const res = await fetchServer(`${baseUrl}/api/status`, {
        headers: {
          'X-Svpn-Api': '1',
          Cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
          [CSRF_HEADER]: 'wrong-token',
        },
      });
      assert.equal(res.status, 403);
    });

    it('accepts API call with valid cookie and CSRF', async () => {
      const bsRes = await fetchServer(`${baseUrl}/api/bootstrap`, { headers: { Host: baseHost } });
      const bsData = await bsRes.json();
      const cookie = bsRes.headers.get('set-cookie')!;
      const sessionId = cookie.match(/svpn-session=([^;]+)/)![1];

      const res = await fetchServer(`${baseUrl}/api/status`, {
        headers: {
          Host: baseHost,
          'X-Svpn-Api': '1',
          Cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
          [CSRF_HEADER]: bsData.csrfToken,
        },
      });
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.equal(data.status, 'ok');
    });
    it('rejects API call without X-Svpn-Api header', async () => {
      const bsRes = await fetchServer(`${baseUrl}/api/bootstrap`, { headers: { Host: baseHost } });
      const bsData = await bsRes.json();
      const cookie = bsRes.headers.get('set-cookie')!;
      const sessionId = cookie.match(/svpn-session=([^;]+)/)![1];

      const res = await fetchServer(`${baseUrl}/api/status`, {
        headers: {
          Host: baseHost,
          Cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
          [CSRF_HEADER]: bsData.csrfToken,
        },
      });
      assert.equal(res.status, 400);
    });

    it('sets CSP header on responses', async () => {
      const res = await fetchServer(`${baseUrl}/`, { headers: { Host: baseHost } });
      assert.ok(res.headers.get('content-security-policy')?.includes("script-src 'self'"));
    });
  });

  describe('body size limit', () => {
    it('rejects oversized POST body', async () => {
      const bsRes = await fetchServer(`${baseUrl}/api/bootstrap`, { headers: { Host: baseHost } });
      const bsData = await bsRes.json();
      const cookie = bsRes.headers.get('set-cookie')!;
      const sessionId = cookie.match(/svpn-session=([^;]+)/)![1];

      const bigBody = 'x'.repeat(128 * 1024);
      const res = await fetchServer(`${baseUrl}/api/some-endpoint`, {
        method: 'POST',
        headers: {
          Host: baseHost,
          'X-Svpn-Api': '1',
          Cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
          [CSRF_HEADER]: bsData.csrfToken,
          'Content-Type': 'application/json',
        },
        body: bigBody,
      });
      assert.equal(res.status, 413);
    });
  });

  describe('API router', () => {
    it('GET /api/status returns node status', async () => {
      const res = await api('GET', '/api/status');
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.equal(data.role, 'anchor');
      assert.ok(Array.isArray(data.peers));
    });

    it('POST /api/invites creates an invite (201)', async () => {
      const res = await api('POST', '/api/invites', { 'Idempotency-Key': 'k1' }, { playerName: 'bob' });
      const data = await res.json();
      assert.equal(res.status, 201);
      assert.equal(data.inviteID, 'inv1');
      assert.deepEqual(services.calls['createInvite'], [['bob']]);
    });

    it('replays identical Idempotency-Key without re-invoking service', async () => {
      await api('POST', '/api/invites', { 'Idempotency-Key': 'dup' }, { playerName: 'bob' });
      const res2 = await api('POST', '/api/invites', { 'Idempotency-Key': 'dup' }, { playerName: 'bob' });
      assert.equal(res2.status, 200);
      assert.equal(services.calls['createInvite']!.length, 1, 'service invoked once');
    });

    it('returns 409 when Idempotency-Key reused with different body', async () => {
      await api('POST', '/api/invites', { 'Idempotency-Key': 'mm' }, { playerName: 'bob' });
      const res2 = await api('POST', '/api/invites', { 'Idempotency-Key': 'mm' }, { playerName: 'alice' });
      assert.equal(res2.status, 409);
    });

    it('POST /api/replies/import returns 409 on consumed invite', async () => {
      services.replyConflict = true;
      const res = await api('POST', '/api/replies/import', {}, { reply: 'R' });
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.code, 'CONFLICT');
    });

    it('DELETE /api/invites/{id} revokes', async () => {
      const res = await api('DELETE', '/api/invites/inv-42');
      assert.equal(res.status, 200);
      assert.deepEqual(services.calls['revokeInvite'], [['inv-42']]);
    });

    it('DELETE /api/peers/{key} removes peer', async () => {
      const res = await api('DELETE', '/api/peers/PUBKEY123');
      assert.equal(res.status, 200);
      assert.deepEqual(services.calls['removePeer'], [['PUBKEY123']]);
    });

    it('POST /api/probe runs diagnostics', async () => {
      const res = await api('POST', '/api/probe');
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.equal(data.tunnel.result, 'green');
    });

    it('POST /api/guard toggles guard consent', async () => {
      const res = await api('POST', '/api/guard', {}, { consented: true });
      assert.equal(res.status, 200);
      assert.deepEqual(services.calls['setGuard'], [[true]]);
    });

    it('GET/PATCH /api/settings', async () => {
      const g = await api('GET', '/api/settings');
      assert.equal(g.status, 200);
      const p = await api('PATCH', '/api/settings', {}, { name: 'newname' });
      assert.equal(p.status, 200);
      assert.deepEqual(services.calls['patchSettings'], [[{ name: 'newname' }]]);
    });

    it('unknown API path returns 404 {code,message}', async () => {
      const res = await api('GET', '/api/nope');
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.code, 'NOT_FOUND');
    });

    it('GET /api/status/stream opens an SSE stream (no CSRF/version headers)', async () => {
      const { cookie } = await authSession();
      const res = await fetchServer(`${baseUrl}/api/status/stream`, {
        headers: { Host: baseHost, Cookie: cookie },
      });
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type')!.includes('text/event-stream'));
      await res.body?.cancel();
    });
  });
});
