import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { signWithDomainTag, verifyWithDomainTag, sha256, DOMAIN_TAGS, toBase64url, fromBase64url } from './crypto.js';
import { jcsCanonicalize } from './canonical.js';

// PRD Control Channel Protocol (C4): overlay-only daemon↔daemon HTTP on port 8421.
export const CTRL_PORT = 8421;
export const CTRL_SKEW_SEC = 120;
export const CTRL_NONCE_SIZE = 16; // 128-bit
export const CTRL_RATE_LIMIT = 10; // requests per minute per member
export const CTRL_RATE_WINDOW_MS = 60_000;
export const CTRL_PROTOCOL_VERSION = 1;

/**
 * Replay-defense nonce cache. Holds seen nonces for >= 2x the skew window.
 * Optionally hydrated/persisted by the caller (entries survive restart per PRD).
 */
export class NonceCache {
  private seen = new Map<string, number>();
  constructor(private readonly ttlMs: number = CTRL_SKEW_SEC * 2 * 1000) {}

  has(nonce: string, now: number = Date.now()): boolean {
    this.prune(now);
    return this.seen.has(nonce);
  }

  add(nonce: string, now: number = Date.now()): void {
    this.seen.set(nonce, now + this.ttlMs);
  }

  prune(now: number = Date.now()): void {
    for (const [n, exp] of this.seen) {
      if (exp <= now) this.seen.delete(n);
    }
  }

  export(): Array<[string, number]> {
    return [...this.seen.entries()];
  }

  import(entries: Array<[string, number]>): void {
    for (const [n, exp] of entries) this.seen.set(n, exp);
  }

  size(): number {
    return this.seen.size;
  }
}

function signedRequestDigest(params: {
  method: string;
  path: string;
  bodySha256: string;
  ts: number;
  nonce: string;
  keyID: string;
}): Buffer {
  return jcsCanonicalize(params);
}

export interface AuthedRequest {
  keyID: string;
  method: string;
  path: string;
  body: Buffer;
  nonce: string;
}

export type CtrlHandler = (req: AuthedRequest) => Promise<{ status: number; body: unknown }>;

export interface ControlServerOptions {
  overlayIP: string;
  port?: number;
  privateKey: Buffer; // own identity (sig) private key, raw 32B
  /** Resolve an active roster member's raw 32B sig pubkey by keyID (base64url). Null if not a member. */
  getMemberKey: (keyID: string) => Buffer | null;
  handlers: Record<string, CtrlHandler>; // keyed by "METHOD path"
  nonceCache?: NonceCache;
}

export class ControlServer {
  private server: Server | null = null;
  private readonly port: number;
  private readonly nonceCache: NonceCache;
  private readonly rate = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly opts: ControlServerOptions) {
    this.port = opts.port ?? CTRL_PORT;
    this.nonceCache = opts.nonceCache ?? new NonceCache();
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handle(req, res));
      this.server.once('error', reject);
      // Bind to overlay IP only — never loopback, never 0.0.0.0.
      this.server.listen(this.port, this.opts.overlayIP, () => {
        this.server!.removeListener('error', reject);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  getNonceCache(): NonceCache {
    return this.nonceCache;
  }

  private checkRate(keyID: string, now: number): boolean {
    const entry = this.rate.get(keyID);
    if (!entry || now >= entry.resetAt) {
      this.rate.set(keyID, { count: 1, resetAt: now + CTRL_RATE_WINDOW_MS });
      return true;
    }
    if (entry.count >= CTRL_RATE_LIMIT) return false;
    entry.count++;
    return true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readBody(req);
      const method = req.method ?? 'GET';
      const path = (req.url ?? '/').split('?')[0]!;

      const keyID = header(req, 'x-svpn-key');
      const tsRaw = header(req, 'x-svpn-ts');
      const nonce = header(req, 'x-svpn-nonce');
      const sig = header(req, 'x-svpn-sig');

      if (!keyID || !tsRaw || !nonce || !sig) {
        return sendJson(res, 401, { code: 'UNAUTHENTICATED', message: 'Missing svpn-ctrl-v1 headers' });
      }

      const memberKey = this.opts.getMemberKey(keyID);
      if (!memberKey) {
        return sendJson(res, 401, { code: 'UNKNOWN_KEY', message: 'Key is not an active roster member' });
      }

      const now = Date.now();
      const ts = parseInt(tsRaw, 10);
      if (!Number.isFinite(ts) || Math.abs(Math.floor(now / 1000) - ts) > CTRL_SKEW_SEC) {
        return sendJson(res, 401, { code: 'STALE', message: 'Timestamp outside allowed skew' });
      }

      if (this.nonceCache.has(nonce)) {
        return sendJson(res, 401, { code: 'REPLAY', message: 'Nonce already seen' });
      }

      const digest = signedRequestDigest({
        method, path, bodySha256: toBase64url(sha256(body)), ts, nonce, keyID,
      });
      if (!verifyWithDomainTag(digest, fromBase64url(sig), memberKey, DOMAIN_TAGS.ctrl)) {
        return sendJson(res, 401, { code: 'BAD_SIG', message: 'Signature verification failed' });
      }

      if (!this.checkRate(keyID, now)) {
        return sendJson(res, 429, { code: 'RATE_LIMITED', message: 'Too many control requests' });
      }

      // Accept: record nonce to prevent replay.
      this.nonceCache.add(nonce, now);

      const handler = this.opts.handlers[`${method} ${path}`];
      if (!handler) {
        return sendJson(res, 404, { code: 'NOT_FOUND', message: 'No such control endpoint' });
      }

      const result = await handler({ keyID, method, path, body, nonce });
      // Response binding: sign {payload, nonce} so requester can reject stale/replayed responses.
      return this.sendSigned(res, result.status, result.body, nonce);
    } catch (err) {
      return sendJson(res, 400, { code: 'BAD_REQUEST', message: (err as Error).message });
    }
  }

  private sendSigned(res: ServerResponse, status: number, payload: unknown, nonce: string): void {
    const envelope = { v: CTRL_PROTOCOL_VERSION, payload, nonce };
    const sig = toBase64url(signWithDomainTag(jcsCanonicalize(envelope), this.opts.privateKey, DOMAIN_TAGS.ctrl));
    sendJson(res, status, { ...envelope, sig });
  }
}

export interface ControlClientOptions {
  targetHost: string;
  targetPort?: number;
  privateKey: Buffer;   // own identity (sig) private key raw 32B
  keyID: string;        // own sig pubkey base64url
  anchorSigPubkey: Buffer; // to verify response signatures
}

export interface CtrlResponse {
  status: number;
  payload: unknown;
}

export class ControlClient {
  private readonly port: number;
  constructor(private readonly opts: ControlClientOptions) {
    this.port = opts.targetPort ?? CTRL_PORT;
  }

  async send(method: string, path: string, body: unknown = null): Promise<CtrlResponse> {
    const bodyBuf = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf-8');
    const ts = Math.floor(Date.now() / 1000);
    const nonce = toBase64url(randomBytes(CTRL_NONCE_SIZE));
    const digest = signedRequestDigest({
      method, path, bodySha256: toBase64url(sha256(bodyBuf)), ts, nonce, keyID: this.opts.keyID,
    });
    const sig = toBase64url(signWithDomainTag(digest, this.opts.privateKey, DOMAIN_TAGS.ctrl));

    const { status, raw } = await this.httpSend(method, path, bodyBuf, {
      'x-svpn-key': this.opts.keyID,
      'x-svpn-ts': String(ts),
      'x-svpn-nonce': nonce,
      'x-svpn-sig': sig,
      'content-type': 'application/json',
    });

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { status, payload: null };
    }

    // Verify response binding when the server signed it.
    if (typeof parsed['sig'] === 'string' && typeof parsed['nonce'] === 'string') {
      const { sig: respSig, ...envelope } = parsed;
      if (parsed['nonce'] !== nonce) {
        throw new Error('Control response nonce mismatch (possible replay)');
      }
      const ok = verifyWithDomainTag(
        jcsCanonicalize(envelope),
        fromBase64url(respSig as string),
        this.opts.anchorSigPubkey,
        DOMAIN_TAGS.ctrl,
      );
      if (!ok) throw new Error('Control response signature invalid');
      return { status, payload: (envelope as Record<string, unknown>)['payload'] };
    }

    return { status, payload: parsed };
  }

  private httpSend(
    method: string,
    path: string,
    body: Buffer,
    headers: Record<string, string>,
  ): Promise<{ status: number; raw: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: this.opts.targetHost, port: this.port, method, path, headers: { ...headers, connection: 'close' }, agent: false },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, raw: data }));
        },
      );
      req.on('error', reject);
      if (body.length > 0) req.write(body);
      req.end();
    });
  }
}

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  return typeof v === 'string' ? v : null;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) {
        req.destroy();
        reject(new Error('Control request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
