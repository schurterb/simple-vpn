import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { SessionStore, SESSION_COOKIE_NAME, CSRF_HEADER, makeSessionCookie, type Session } from './session.js';

const MAX_BODY_SIZE = 64 * 1024;

/** Domain operations the API exposes. Injected so the daemon wires real modules and tests mock them. */
export interface ApiServices {
  getStatus(): Promise<unknown>;
  createInvite(playerName: string): Promise<unknown>;
  importInvite(invite: string): Promise<unknown>;
  importReply(reply: string): Promise<unknown>;
  revokeInvite(inviteID: string): Promise<void>;
  removePeer(wgPubkey: string): Promise<void>;
  probe(): Promise<unknown>;
  setListener(enabled: boolean): Promise<unknown>;
  setGuard(consented: boolean): Promise<unknown>;
  getSettings(): Promise<unknown>;
  patchSettings(patch: Record<string, unknown>): Promise<unknown>;
  /** Subscribe to status pushes for SSE; returns an unsubscribe function. */
  onStatusChange?(cb: (status: unknown) => void): () => void;
}

/** Thrown by services to produce a specific HTTP status + error body. */
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export type IdempotencyResult =
  | { kind: 'miss' }
  | { kind: 'replay'; response: unknown }
  | { kind: 'mismatch' };

export interface IdempotencyStore {
  check(key: string, bodyHash: string): IdempotencyResult;
  store(key: string, bodyHash: string, response: unknown): void;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

class MemoryIdempotencyStore implements IdempotencyStore {
  private map = new Map<string, { bodyHash: string; response: unknown; expiresAt: number }>();
  check(key: string, bodyHash: string): IdempotencyResult {
    const e = this.map.get(key);
    if (!e || e.expiresAt <= Date.now()) return { kind: 'miss' };
    if (e.bodyHash !== bodyHash) return { kind: 'mismatch' };
    return { kind: 'replay', response: e.response };
  }
  store(key: string, bodyHash: string, response: unknown): void {
    this.map.set(key, { bodyHash, response, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
  }
}
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface ApiServerOptions {
  port: number;
  wwwDir: string;
  canonicalHost: string;
  services?: ApiServices;
  idempotency?: IdempotencyStore;
}

export class ApiServer {
  private server: Server | null = null;
  private readonly sessions = new SessionStore();
  private readonly idempotency: IdempotencyStore;

  constructor(private readonly opts: ApiServerOptions) {
    this.idempotency = opts.idempotency ?? new MemoryIdempotencyStore();
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.opts.port, '127.0.0.1', () => {
        this.server!.removeListener('error', reject);
        resolve();
      });
    });

    // Also listen on ::1, but don't fail if IPv6 is unavailable
    try {
      await new Promise<void>((resolve) => {
        this.server!.listen(this.opts.port, '::1', () => resolve());
        this.server!.once('error', () => resolve());
      });
    } catch {
      // IPv6 not available, ignore
    }
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  get address(): string {
    return `http://127.0.0.1:${this.opts.port}`;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'");

    const remoteAddr = req.socket.remoteAddress;
    if (!isLoopback(remoteAddr)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: non-loopback access denied');
      return;
    }

    const host = req.headers['host'];
    if (host !== this.opts.canonicalHost) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: host mismatch');
      return;
    }

    const url = req.url ?? '/';
    const path = url.split('?')[0]!;

    if (path === '/api/bootstrap') {
      await this.handleBootstrap(req, res);
      return;
    }

    if (path.startsWith('/api/')) {
      await this.handleApi(req, res, path);
      return;
    }

    await this.serveStatic(req, res, path);
  }

  // VALIDATE[minor] F15 (PRD CF6): PRD bootstrap = GET / sets cookie + embeds CSRF in meta tag.
  // This JSON endpoint is a workable deviation; GET / currently issues no session. Align or document.
  private async handleBootstrap(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    const session = this.sessions.createSession();
    res.setHeader('Set-Cookie', makeSessionCookie(session.id));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ csrfToken: session.csrfToken }));
  }

  private async handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<void> {
    const method = req.method ?? 'GET';

    // SSE stream: EventSource cannot set headers, so it authenticates by session cookie
    // + Host check only (no X-Svpn-Api / CSRF). It is a read-only endpoint.
    if (path === '/api/status/stream' && method === 'GET') {
      const session = this.authenticate(req);
      if (!session) return sendError(res, 401, 'UNAUTHORIZED', 'Invalid or missing session');
      return this.handleStatusStream(req, res);
    }

    const apiVersion = req.headers['x-svpn-api'];
    if (apiVersion !== '1') {
      return sendError(res, 400, 'BAD_VERSION', 'X-Svpn-Api header must be "1"');
    }

    const session = this.authenticate(req);
    if (!session) return sendError(res, 401, 'UNAUTHORIZED', 'Invalid or missing session');

    const csrfToken = req.headers[CSRF_HEADER] as string | undefined;
    if (!csrfToken || !this.sessions.validateCsrf(session, csrfToken)) {
      return sendError(res, 403, 'FORBIDDEN', 'Invalid CSRF token');
    }

    if (!this.sessions.checkRateLimit(session)) {
      return sendError(res, 429, 'RATE_LIMITED', 'Too Many Requests');
    }

    // Read + size-limit the body for mutating requests.
    let body: Buffer;
    try {
      body = await this.readBody(req);
    } catch {
      return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Payload Too Large');
    }

    if (!this.opts.services) {
      return sendError(res, 503, 'UNAVAILABLE', 'API services not configured');
    }

    try {
      await this.route(method, path, body, res);
    } catch (err) {
      if (err instanceof ApiError) {
        return sendError(res, err.status, err.code, err.message);
      }
      return sendError(res, 500, 'INTERNAL', (err as Error).message);
    }
  }

  private async route(method: string, path: string, body: Buffer, res: ServerResponse): Promise<void> {
    const svc = this.opts.services!;
    const json = () => (body.length > 0 ? JSON.parse(body.toString('utf-8')) : {});

    // Path-parameter routes first.
    const inviteDel = /^\/api\/invites\/([^/]+)$/.exec(path);
    if (inviteDel && method === 'DELETE') {
      await svc.revokeInvite(decodeURIComponent(inviteDel[1]!));
      return sendJson(res, 200, { ok: true });
    }
    const peerDel = /^\/api\/peers\/([^/]+)$/.exec(path);
    if (peerDel && method === 'DELETE') {
      await svc.removePeer(decodeURIComponent(peerDel[1]!));
      return sendJson(res, 200, { ok: true });
    }

    switch (`${method} ${path}`) {
      case 'GET /api/status':
        return sendJson(res, 200, await svc.getStatus());
      case 'POST /api/invites':
        return this.withIdempotency(res, body, async () => ({ status: 201, body: await svc.createInvite(String(json().playerName ?? '')) }));
      case 'POST /api/invites/import':
        return sendJson(res, 200, await svc.importInvite(String(json().invite ?? '')));
      case 'POST /api/replies/import':
        return sendJson(res, 200, await svc.importReply(String(json().reply ?? '')));
      case 'POST /api/probe':
        return sendJson(res, 200, await svc.probe());
      case 'POST /api/listener':
        return this.withIdempotency(res, body, async () => ({ status: 200, body: await svc.setListener(Boolean(json().enabled)) }));
      case 'POST /api/guard':
        return sendJson(res, 200, await svc.setGuard(Boolean(json().consented)));
      case 'GET /api/settings':
        return sendJson(res, 200, await svc.getSettings());
      case 'PATCH /api/settings':
        return sendJson(res, 200, await svc.patchSettings(json() as Record<string, unknown>));
      default:
        return sendError(res, 404, 'NOT_FOUND', 'Not Found');
    }
  }

  /** Idempotency-Key handling for create-style POSTs (PRD: key+body-hash 24h; replay/mismatch). */
  private async withIdempotency(
    res: ServerResponse,
    body: Buffer,
    run: () => Promise<{ status: number; body: unknown }>,
  ): Promise<void> {
    const key = this.currentIdempotencyKey;
    if (!key) {
      const r = await run();
      return sendJson(res, r.status, r.body);
    }
    const bodyHash = createHash('sha256').update(body).digest('base64url');
    const existing = this.idempotency.check(key, bodyHash);
    if (existing.kind === 'replay') return sendJson(res, 200, existing.response);
    if (existing.kind === 'mismatch') return sendError(res, 409, 'IDEMPOTENCY_MISMATCH', 'Idempotency-Key reused with a different body');
    const r = await run();
    this.idempotency.store(key, bodyHash, r.body);
    return sendJson(res, r.status, r.body);
  }

  private currentIdempotencyKey: string | null = null;

  private handleStatusStream(req: IncomingMessage, res: ServerResponse): void {
    if (!this.sessions.acquireSseSlot()) {
      return sendError(res, 503, 'SSE_LIMIT', 'Too many active status streams');
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    const send = (status: unknown): void => {
      res.write(`data: ${JSON.stringify(status)}\n\n`);
    };
    if (this.opts.services) {
      void this.opts.services.getStatus().then(send).catch(() => {});
    }
    const unsub = this.opts.services?.onStatusChange?.(send);
    const cleanup = (): void => {
      this.sessions.releaseSseSlot();
      unsub?.();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  private authenticate(req: IncomingMessage): Session | null {
    const cookieHeader = req.headers['cookie'] ?? '';
    const cookies = parseCookies(cookieHeader);
    const sessionId = cookies[SESSION_COOKIE_NAME];
    if (!sessionId) return null;
    return this.sessions.getSession(sessionId);
  }

  private readBody(req: IncomingMessage): Promise<Buffer> {
    // Capture the idempotency key alongside the body read.
    const k = req.headers['idempotency-key'];
    this.currentIdempotencyKey = typeof k === 'string' ? k : null;

    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
    if (contentLength > MAX_BODY_SIZE) return Promise.reject(new Error('too large'));

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let received = 0;
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_BODY_SIZE) {
          req.destroy();
          reject(new Error('too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  private async serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    const safePath = safeJoin(this.opts.wwwDir, path);
    if (!safePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: path traversal denied');
      return;
    }

    try {
      const stats = await stat(safePath);
      if (stats.isDirectory()) {
        const indexPath = join(safePath, 'index.html');
        try {
          const content = await readFile(indexPath);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          if (req.method === 'HEAD') { res.end(); return; }
          res.end(content);
          return;
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
      }

      const content = await readFile(safePath);
      const mime = MIME_TYPES[extname(safePath)] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      if (req.method === 'HEAD') { res.end(); return; }
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }
}

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    cookies[key] = value;
  }
  return cookies;
}

function safeJoin(base: string, path: string): string | null {
  const normalized = normalize(join(base, path));
  if (!normalized.startsWith(base)) return null;
  return normalized;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body ?? null));
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code, message }));
}
