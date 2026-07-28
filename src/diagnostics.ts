import { createSocket, type Socket } from 'node:dgram';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { signWithDomainTag, verifyWithDomainTag, DOMAIN_TAGS } from './crypto.js';
import type { WgInterfaceStatus } from './wg-uapi.js';

// PRD CF8 C2: 8-byte nonce for the authenticated overlay UDP echo.
export const DIAG_NONCE_SIZE = 8;
export const DIAG_PORT = 42421;

export type DiagResult = 'green' | 'yellow' | 'red';
export type DiagCategory = 'tunnel' | 'tcp' | 'udp';

export interface DiagnosticReport {
  tunnel: { result: DiagResult; detail: string };
  tcp: { result: DiagResult; detail: string };
  udp: { result: DiagResult; detail: string };
}

const STALE_THRESHOLD_SEC = 180;

export function diagnoseTunnel(status: WgInterfaceStatus): { result: DiagResult; detail: string } {
  if (status.peers.length === 0) {
    return { result: 'yellow', detail: 'No peers configured.' };
  }

  const now = Math.floor(Date.now() / 1000);
  const allFresh = status.peers.every(
    (p) => p.lastHandshakeTimeSec > 0 && (now - p.lastHandshakeTimeSec) < STALE_THRESHOLD_SEC,
  );
  const anyFresh = status.peers.some(
    (p) => p.lastHandshakeTimeSec > 0 && (now - p.lastHandshakeTimeSec) < STALE_THRESHOLD_SEC,
  );
  const totalRx = status.peers.reduce((sum, p) => sum + p.rxBytes, 0);
  const totalTx = status.peers.reduce((sum, p) => sum + p.txBytes, 0);

  if (allFresh) {
    return {
      result: 'green',
      detail: `All ${status.peers.length} peer(s) have fresh handshakes. RX: ${totalRx}B, TX: ${totalTx}B.`,
    };
  }

  if (anyFresh) {
    const stale = status.peers.filter(
      (p) => p.lastHandshakeTimeSec === 0 || (now - p.lastHandshakeTimeSec) >= STALE_THRESHOLD_SEC,
    );
    return {
      result: 'yellow',
      detail: `${status.peers.length - stale.length} peer(s) active, ${stale.length} stale.`,
    };
  }

  return {
    result: 'red',
    detail: 'No peers have fresh handshakes. Tunnel may be down.',
  };
}

export function diagnoseTcp(
  host: string,
  port: number,
  timeoutMs: number = 3000,
): Promise<{ result: DiagResult; detail: string }> {
  return new Promise((resolve) => {
    const sock = connect({ host, port, timeout: timeoutMs }, () => {
      sock.destroy();
      resolve({ result: 'green', detail: `TCP ${host}:${port} reachable.` });
    });

    sock.on('timeout', () => {
      sock.destroy();
      resolve({ result: 'red', detail: `TCP ${host}:${port} timed out.` });
    });

    sock.on('error', (err) => {
      resolve({
        result: 'red',
        detail: `TCP ${host}:${port} failed: ${err.message}`,
      });
    });
  });
}

export interface UdpEchoResult {
  result: DiagResult;
  detail: string;
}

export function diagnoseUdp(
  host: string,
  port: number,
  privateKey: Buffer,
  peerPublicKey: Buffer,
  timeoutMs: number = 3000,
): Promise<UdpEchoResult> {
  return new Promise((resolve) => {
    const sock = createSocket('udp4');
    const nonce = randomBytes(DIAG_NONCE_SIZE);
    const signature = signWithDomainTag(nonce, privateKey, DOMAIN_TAGS.ctrl);

    const message = Buffer.concat([nonce, signature]);

    const timer = setTimeout(() => {
      sock.close();
      resolve({ result: 'red', detail: `UDP ${host}:${port} timed out.` });
    }, timeoutMs);

    sock.on('message', (data) => {
      clearTimeout(timer);
      sock.close();

      if (data.length < DIAG_NONCE_SIZE) {
        resolve({ result: 'red', detail: 'UDP echo response too short.' });
        return;
      }

      const echoNonce = data.subarray(0, DIAG_NONCE_SIZE);
      const echoSig = data.subarray(DIAG_NONCE_SIZE);

      if (!echoNonce.equals(nonce)) {
        resolve({ result: 'red', detail: 'UDP echo nonce mismatch.' });
        return;
      }

      if (!verifyWithDomainTag(echoNonce, echoSig, peerPublicKey, DOMAIN_TAGS.ctrl)) {
        resolve({ result: 'red', detail: 'UDP echo signature verification failed.' });
        return;
      }

      resolve({
        result: 'green',
        detail: `UDP ${host}:${port} authenticated echo verified.`,
      });
    });

    sock.on('error', (err) => {
      clearTimeout(timer);
      sock.close();
      resolve({ result: 'red', detail: `UDP ${host}:${port} error: ${err.message}` });
    });

    sock.send(message, port, host);
  });
}

export async function runDiagnostics(
  wgStatus: WgInterfaceStatus,
  anchorHost: string,
  gamePort: number,
  diagPort: number,
  privateKey: Buffer,
  peerPublicKey: Buffer,
): Promise<DiagnosticReport> {
  const [tcpResult, udpResult] = await Promise.all([
    diagnoseTcp(anchorHost, gamePort),
    diagnoseUdp(anchorHost, diagPort, privateKey, peerPublicKey),
  ]);

  return {
    tunnel: diagnoseTunnel(wgStatus),
    tcp: tcpResult,
    udp: udpResult,
  };
}

/**
 * Authenticated overlay UDP echo responder (PRD CF8 C2).
 * Binds ONLY to the node's overlay IP on the diagnostic port (never 0.0.0.0).
 * Verifies an 8-byte nonce signed by a known peer identity key, then countersigns it.
 */
export class EchoResponder {
  private socket: Socket | null = null;

  constructor(
    private readonly overlayIP: string,
    private readonly privateKey: Buffer,
    private readonly knownPeerKeys: Buffer[],
    private readonly port: number = DIAG_PORT,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createSocket('udp4');
      this.socket.on('error', reject);
      this.socket.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo));
      // Bind to overlay IP only — diagnostic path must not be internet-reachable.
      this.socket.bind(this.port, this.overlayIP, () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.socket) return resolve();
      this.socket.close(() => resolve());
      this.socket = null;
    });
  }

  setKnownPeerKeys(keys: Buffer[]): void {
    (this.knownPeerKeys as Buffer[]).length = 0;
    (this.knownPeerKeys as Buffer[]).push(...keys);
  }

  private handleMessage(msg: Buffer, rinfo: { address: string; port: number }): void {
    if (msg.length < DIAG_NONCE_SIZE + 1) return;
    const nonce = msg.subarray(0, DIAG_NONCE_SIZE);
    const sig = msg.subarray(DIAG_NONCE_SIZE);
    const authed = this.knownPeerKeys.some((k) =>
      verifyWithDomainTag(nonce, sig, k, DOMAIN_TAGS.ctrl),
    );
    if (!authed) return;
    const respSig = signWithDomainTag(nonce, this.privateKey, DOMAIN_TAGS.ctrl);
    this.socket?.send(Buffer.concat([nonce, respSig]), rinfo.port, rinfo.address);
  }
}
