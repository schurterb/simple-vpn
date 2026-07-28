import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { encodeUAPISet, parseUAPIGet, type WgInterfaceConfig, type WgInterfaceStatus } from './wg-uapi.js';
import type { SupportedPlatform } from './platform.js';

export interface WgDeviceOptions {
  binaryPath: string;
  interfaceName: string;
  platform: SupportedPlatform;
  socketDir: string;
}

export class UAPIError extends Error {
  constructor(public readonly errno: number, message: string) {
    super(message);
    this.name = 'UAPIError';
  }
}

export class WgManager {
  private process: ChildProcess | null = null;
  private socket: Socket | null = null;
  private actualInterfaceName: string | null = null;
  private socketPath: string | null = null;
  private pipePath: string | null = null;

  constructor(private readonly opts: WgDeviceOptions) {}

  async start(): Promise<void> {
    if (this.opts.platform === 'win32') {
      // Standard wireguard-go/WireGuard for Windows named pipe (upstream-pinned path).
      this.pipePath = `\\\\.\\pipe\\ProtectedPrefix\\Administrators\\WireGuard\\${this.opts.interfaceName}`;
      this.actualInterfaceName = this.opts.interfaceName;
    } else {
      const sockDir = this.opts.platform === 'linux'
        ? '/var/run/wireguard'
        : this.opts.socketDir;

      if (this.opts.platform === 'linux') {
        mkdirSync(sockDir, { recursive: true });
      }

      this.socketPath = join(sockDir, `${this.opts.interfaceName}.sock`);
    }

    this.process = spawn(this.opts.binaryPath, [this.opts.interfaceName], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WG_TUN_NAME_FILE: this.opts.platform === 'darwin'
          ? join(this.opts.socketDir, 'tunname')
          : undefined,
      },
    });

    if (this.opts.platform === 'win32') {
      await this.waitForPipe();
    } else {
      await this.waitForSocket();
    }

    if (this.opts.platform === 'darwin') {
      const tunNameFile = join(this.opts.socketDir, 'tunname');
      if (existsSync(tunNameFile)) {
        this.actualInterfaceName = readFileSync(tunNameFile, 'utf-8').trim();
      }
    }
  }

  private async waitForSocket(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(this.socketPath!)) return;
      await sleep(50);
    }
    throw new Error(`WireGuard UAPI socket not found at ${this.socketPath} within ${timeoutMs}ms`);
  }

  private async waitForPipe(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const sock = createConnection(this.pipePath!, () => {
          sock.destroy();
        });
        await new Promise<void>((resolve, reject) => {
          sock.on('connect', () => resolve());
          sock.on('error', () => reject(new Error('not ready')));
        });
        return;
      } catch {
        await sleep(50);
      }
    }
    throw new Error(`WireGuard named pipe ${this.pipePath} not available within ${timeoutMs}ms`);
  }

  async setConfig(config: WgInterfaceConfig): Promise<void> {
    const sock = await this.connectUAPI();
    const data = encodeUAPISet(config);
    let response = '';
    sock.on('data', (chunk) => { response += chunk.toString(); });
    sock.write(data);
    sock.end();
    await waitForEnd(sock);
    // UAPI replies with `errno=<n>\n\n`; nonzero means the set failed. Throwing here
    // lets the reconciler roll back to the previous generation.
    const errno = parseErrno(response);
    if (errno !== 0) {
      throw new UAPIError(errno, `WireGuard UAPI set failed with errno=${errno}`);
    }
  }

  async getStatus(): Promise<WgInterfaceStatus> {
    const sock = await this.connectUAPI();
    sock.write('get=1\n\n');
    let data = '';
    sock.on('data', (chunk) => { data += chunk.toString(); });
    await waitForEnd(sock);
    return parseUAPIGet(data);
  }

  async stop(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;

    if (this.process) {
      this.process.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (!this.process) return resolve();
        this.process!.on('exit', () => resolve());
        setTimeout(() => {
          this.process?.kill('SIGKILL');
          resolve();
        }, 3000);
      });
      this.process = null;
    }

    this.actualInterfaceName = null;
  }

  getInterfaceName(): string | null {
    return this.actualInterfaceName;
  }

  isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  private async connectUAPI(): Promise<Socket> {
    const target = this.pipePath ?? this.socketPath!;
    return new Promise((resolve, reject) => {
      const sock = createConnection(target, () => resolve(sock));
      sock.on('error', reject);
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForEnd(sock: Socket): Promise<void> {
  return new Promise((resolve) => {
    sock.on('end', () => resolve());
    sock.on('close', () => resolve());
  });
}

/** Parse the `errno=<n>` line from a UAPI set response. Absent errno is treated as success (0). */
export function parseErrno(response: string): number {
  for (const line of response.split('\n')) {
    const m = /^errno=(-?\d+)$/.exec(line.trim());
    if (m) return Number(m[1]);
  }
  return 0;
}
