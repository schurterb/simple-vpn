export interface WgPeerConfig {
  publicKey: string;
  endpoint?: string;
  allowedIPs: string[];
  persistentKeepaliveInterval?: number;
}

export interface WgInterfaceConfig {
  privateKey: string;
  listenPort?: number;
  peers: WgPeerConfig[];
}

export interface WgPeerStatus {
  publicKey: string;
  endpoint: string | null;
  allowedIPs: string[];
  lastHandshakeTimeSec: number;
  rxBytes: number;
  txBytes: number;
  persistentKeepaliveInterval: number;
}

export interface WgInterfaceStatus {
  publicKey: string;
  listenPort: number;
  peers: WgPeerStatus[];
}

export function encodeUAPISet(config: WgInterfaceConfig): string {
  const lines: string[] = [];
  lines.push(`private_key=${hexKey(config.privateKey)}`);
  if (config.listenPort !== undefined) {
    lines.push(`listen_port=${config.listenPort}`);
  }
  for (const peer of config.peers) {
    lines.push(`public_key=${hexKey(peer.publicKey)}`);
    if (peer.endpoint) {
      lines.push(`endpoint=${peer.endpoint}`);
    }
    for (const ip of peer.allowedIPs) {
      lines.push(`allowed_ip=${ip}`);
    }
    if (peer.persistentKeepaliveInterval !== undefined) {
      lines.push(`persistent_keepalive_interval=${peer.persistentKeepaliveInterval}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function parseUAPIGet(data: string): WgInterfaceStatus {
  const lines = data.split('\n').filter((l) => l.length > 0);
  let publicKey = '';
  let listenPort = 0;
  const peers: WgPeerStatus[] = [];
  let currentPeer: Partial<WgPeerStatus> | null = null;

  for (const line of lines) {
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx);
    const value = line.slice(eqIdx + 1);

    switch (key) {
      case 'private_key':
        break;
      case 'public_key':
        if (currentPeer) peers.push(currentPeer as WgPeerStatus);
        currentPeer = {
          publicKey: value,
          endpoint: null,
          allowedIPs: [],
          lastHandshakeTimeSec: 0,
          rxBytes: 0,
          txBytes: 0,
          persistentKeepaliveInterval: 0,
        };
        break;
      case 'endpoint':
        if (currentPeer) currentPeer.endpoint = value;
        break;
      case 'allowed_ip':
        if (currentPeer) currentPeer.allowedIPs!.push(value);
        break;
      case 'last_handshake_time_sec':
        if (currentPeer) currentPeer.lastHandshakeTimeSec = parseInt(value, 10);
        break;
      case 'rx_bytes':
        if (currentPeer) currentPeer.rxBytes = parseInt(value, 10);
        break;
      case 'tx_bytes':
        if (currentPeer) currentPeer.txBytes = parseInt(value, 10);
        break;
      case 'persistent_keepalive_interval':
        if (currentPeer) currentPeer.persistentKeepaliveInterval = parseInt(value, 10);
        break;
      case 'listen_port':
        listenPort = parseInt(value, 10);
        break;
    }
  }

  if (currentPeer) peers.push(currentPeer as WgPeerStatus);

  return { publicKey, listenPort, peers };
}

function hexKey(base64urlKey: string): string {
  const buf = Buffer.from(base64urlKey, 'base64url');
  return buf.toString('hex');
}
