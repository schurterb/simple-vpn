import { mkdirSync, type WriteStream } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const SENSITIVE_PATTERNS = [
  /private_key/i,
  /wg\.key/i,
  /identity\.key/i,
  /cookie/i,
  /token/i,
  /session/i,
  /password/i,
];

// VALIDATE[minor] F18 (PRD CF7): redaction only masks '=value' when a keyword matches; raw 32B+
// base64/base64url key blobs in other formats still logged. fix: also redact long base64url tokens.
// Also: 14-day log rotation required by PRD — not implemented (single daily files accumulate).
function redact(msg: string): string {
  let result = msg;
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(result)) {
      result = result.replace(/=([^\s]+)/g, '=[REDACTED]');
    }
  }
  return result;
}

export class Logger {
  private stream: WriteStream | null = null;
  private readonly minLevel: LogLevel;

  constructor(
    private readonly logDir: string,
    minLevel: LogLevel = 'info',
  ) {
    this.minLevel = minLevel;
  }

  init(): void {
    mkdirSync(this.logDir, { recursive: true });
    const logFile = join(
      this.logDir,
      `simple-vpn-${new Date().toISOString().slice(0, 10)}.log`,
    );
    this.stream = createWriteStream(logFile, { flags: 'a' });
  }

  log(level: LogLevel, msg: string): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) return;
    const safe = redact(msg);
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${safe}\n`;
    this.stream?.write(line);
    if (level === 'error') {
      process.stderr.write(line);
    } else if (level === 'warn') {
      process.stderr.write(line);
    }
  }

  debug(msg: string): void {
    this.log('debug', msg);
  }
  info(msg: string): void {
    this.log('info', msg);
  }
  warn(msg: string): void {
    this.log('warn', msg);
  }
  error(msg: string): void {
    this.log('error', msg);
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}
