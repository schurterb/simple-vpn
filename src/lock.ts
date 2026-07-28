import { openSync, closeSync, unlinkSync, writeSync, readFileSync } from 'node:fs';

export class SingleInstanceLock {
  private fd: number | null = null;

  constructor(private readonly lockFile: string) {}

  acquire(): boolean {
    try {
      this.fd = openSync(this.lockFile, 'wx');
    } catch {
      return false;
    }
    writeSync(this.fd, String(process.pid));
    return true;
  }

  static readPid(lockFile: string): number | null {
    try {
      const content = readFileSync(lockFile, 'utf-8').trim();
      const pid = parseInt(content, 10);
      return Number.isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  release(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    try {
      unlinkSync(this.lockFile);
    } catch {
      // already removed
    }
  }

  isHeld(): boolean {
    return this.fd !== null;
  }
}
