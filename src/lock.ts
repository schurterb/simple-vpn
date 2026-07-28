import { openSync, closeSync, unlinkSync } from 'node:fs';

export class SingleInstanceLock {
  private fd: number | null = null;

  constructor(private readonly lockFile: string) {}

  acquire(): boolean {
    try {
      this.fd = openSync(this.lockFile, 'wx');
    } catch {
      return false;
    }
    return true;
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
