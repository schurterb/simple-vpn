import { spawn, execFileSync, execSync, type ChildProcess } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { encodeUAPISet, parseUAPIGet, type WgInterfaceConfig, type WgInterfaceStatus } from './wg-uapi.js';
import type { SupportedPlatform } from './platform.js';

export interface WgDeviceOptions {
  binaryPath: string;
  interfaceName: string;
  platform: SupportedPlatform;
  socketDir: string;
  /** Use kernel module (ip link add) instead of spawning wireguard-go. */
  kernelMode?: boolean;
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
    if (this.opts.kernelMode && this.opts.platform === 'linux') {
      return this.startKernel();
    }

    if (this.opts.platform === 'win32') {
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

  private startKernel(): void {
    try {
      execFileSync('ip', ['link', 'add', this.opts.interfaceName, 'type', 'wireguard'], {
        stdio: 'pipe',
        timeout: 5000,
      });
    } catch {
      // Interface may already exist — that's OK.
    }

    this.actualInterfaceName = this.opts.interfaceName;
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
    if (this.opts.kernelMode && this.opts.platform === 'linux') {
      return this.setConfigKernel(config);
    }

    const sock = await this.connectUAPI();
    const data = encodeUAPISet(config);
    let response = '';
    sock.on('data', (chunk) => { response += chunk.toString(); });
    sock.write(data);
    sock.end();
    await waitForEnd(sock);
    const errno = parseErrno(response);
    if (errno !== 0) {
      throw new UAPIError(errno, `WireGuard UAPI set failed with errno=${errno}`);
    }
  }

  async addPeer(peer: { publicKey: string; endpoint?: string; allowedIPs: string[]; persistentKeepaliveInterval?: number }): Promise<void> {
    if (this.opts.kernelMode && this.opts.platform === 'linux') {
      return this.addPeerKernel(peer);
    }
    // For userspace mode, rebuild full config with new peer added
    // (caller should use setConfig with full peer list instead)
    throw new Error('addPeer not supported in userspace mode — use setConfig with full peer list');
  }

  private addPeerKernel(peer: { publicKey: string; endpoint?: string; allowedIPs: string[]; persistentKeepaliveInterval?: number }): void {
    const args = ['set', this.opts.interfaceName, 'peer', b64urlToB64(peer.publicKey)];
    if (peer.endpoint) {
      args.push('endpoint', peer.endpoint);
    }
    if (peer.allowedIPs.length > 0) {
      args.push('allowed-ips', peer.allowedIPs.join(','));
    }
    if (peer.persistentKeepaliveInterval !== undefined) {
      args.push('persistent-keepalive', String(peer.persistentKeepaliveInterval));
    }
    execFileSync('wg', args, { stdio: 'pipe', timeout: 5000 });
  }

  private setConfigKernel(config: WgInterfaceConfig): void {
    // Use `wg setconf` with a temporary config file in wg-quick INI format
    const ini = this.buildWgIni(config);
    const tmpFile = join(tmpdir(), `wg-${this.opts.interfaceName}-${Date.now()}.conf`);
    writeFileSync(tmpFile, ini, { mode: 0o600 });
    try {
      execFileSync('wg', ['setconf', this.opts.interfaceName, tmpFile], {
        stdio: 'pipe',
        timeout: 5000,
      });
    } finally {
      unlinkSync(tmpFile);
    }
  }

  private buildWgIni(config: WgInterfaceConfig): string {
    const lines: string[] = [];
    lines.push('[Interface]');
    lines.push(`PrivateKey = ${b64urlToB64(config.privateKey)}`);
    if (config.listenPort !== undefined) {
      lines.push(`ListenPort = ${config.listenPort}`);
    }
    for (const peer of config.peers) {
      lines.push('');
      lines.push('[Peer]');
      lines.push(`PublicKey = ${b64urlToB64(peer.publicKey)}`);
      if (peer.endpoint) {
        lines.push(`Endpoint = ${peer.endpoint}`);
      }
      if (peer.allowedIPs.length > 0) {
        lines.push(`AllowedIPs = ${peer.allowedIPs.join(', ')}`);
      }
      if (peer.persistentKeepaliveInterval !== undefined) {
        lines.push(`PersistentKeepalive = ${peer.persistentKeepaliveInterval}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  async getStatus(): Promise<WgInterfaceStatus> {
    if (this.opts.kernelMode && this.opts.platform === 'linux') {
      return this.getStatusKernel();
    }

    const sock = await this.connectUAPI();
    sock.write('get=1\n\n');
    let data = '';
    sock.on('data', (chunk) => { data += chunk.toString(); });
    await waitForEnd(sock);
    return parseUAPIGet(data);
  }

  private getStatusKernel(): WgInterfaceStatus {
    // Use `wg show <iface> dump` which outputs tab-separated UAPI-like format
    const output = execSync(`wg show ${this.opts.interfaceName} dump`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return this.parseWgDump(output);
  }

  private parseWgDump(output: string): WgInterfaceStatus {
    const lines = output.trim().split('\n');
    if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
      return { publicKey: '', listenPort: 0, peers: [] };
    }

    // First line: interface info
    // <private-key> <public-key> <listen-port> <fwmark>
    const ifaceParts = lines[0]!.split('\t');
    const listenPort = parseInt(ifaceParts[2] ?? '0', 10);
    const publicKey = ifaceParts[1] ?? '';

    const peers: WgInterfaceStatus['peers'] = [];
    for (let i = 1; i < lines.length; i++) {
      // <public-key> <preshared-key> <endpoint> <allowed-ips> <latest-handshake> <transfer-rx> <transfer-tx> <persistent-keepalive>
      const parts = lines[i]!.split('\t');
      if (parts.length < 8) continue;
      const peerPubKey = parts[0]!;
      const endpoint = parts[2] ?? '';
      const allowedIPs = (parts[3] ?? '').split(',').filter(Boolean);
      const lastHandshake = parseInt(parts[4] ?? '0', 10);
      const rxBytes = parseInt(parts[5] ?? '0', 10);
      const txBytes = parseInt(parts[6] ?? '0', 10);
      const keepalive = parseInt(parts[7] ?? '0', 10);

      peers.push({
        publicKey: peerPubKey,
        endpoint: endpoint || null,
        allowedIPs,
        lastHandshakeTimeSec: lastHandshake,
        rxBytes,
        txBytes,
        persistentKeepaliveInterval: keepalive,
      });
    }

    return { publicKey, listenPort, peers };
  }

  async stop(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;

    if (this.opts.kernelMode && this.opts.platform === 'linux') {
      try {
        execFileSync('ip', ['link', 'del', this.opts.interfaceName], {
          stdio: 'pipe',
          timeout: 5000,
        });
      } catch {
        // best effort
      }
      this.actualInterfaceName = null;
      return;
    }

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
    if (this.opts.kernelMode) {
      return this.actualInterfaceName !== null;
    }
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

function b64urlToB64(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  return pad === 0 ? b64 : b64 + '='.repeat(4 - pad);
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
