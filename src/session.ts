import { randomBytes, timingSafeEqual } from 'node:crypto';

export interface Session {
  id: string;
  csrfToken: string;
  createdAt: number;
  lastAccess: number;
  requestCount: number;
  rateLimitReset: number;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const MAX_SSE_GLOBAL = 10;

export class SessionStore {
  private sessions: Map<string, Session> = new Map();

  createSession(): Session {
    const id = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const now = Date.now();
    const session: Session = {
      id,
      csrfToken,
      createdAt: now,
      lastAccess: now,
      requestCount: 0,
      rateLimitReset: now + RATE_LIMIT_WINDOW_MS,
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string): Session | null {
    const session = this.sessions.get(id);
    if (!session) return null;

    const now = Date.now();
    if (now - session.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(id);
      return null;
    }

    session.lastAccess = now;
    return session;
  }

  destroySession(id: string): void {
    this.sessions.delete(id);
  }

  validateCsrf(session: Session, token: string): boolean {
    const expected = Buffer.from(session.csrfToken);
    const provided = Buffer.from(token);
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
  }

  checkRateLimit(session: Session): boolean {
    const now = Date.now();
    if (now >= session.rateLimitReset) {
      session.requestCount = 0;
      session.rateLimitReset = now + RATE_LIMIT_WINDOW_MS;
    }
    if (session.requestCount >= RATE_LIMIT_MAX_REQUESTS) {
      return false;
    }
    session.requestCount++;
    return true;
  }

  private globalSseCount = 0;

  acquireSseSlot(): boolean {
    if (this.globalSseCount >= MAX_SSE_GLOBAL) {
      return false;
    }
    this.globalSseCount++;
    return true;
  }

  releaseSseSlot(): void {
    if (this.globalSseCount > 0) {
      this.globalSseCount--;
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        this.sessions.delete(id);
      }
    }
  }

  size(): number {
    return this.sessions.size;
  }
}

export const SESSION_COOKIE_NAME = 'svpn-session';
export const CSRF_HEADER = 'x-csrf-token';

export function makeSessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`;
}
