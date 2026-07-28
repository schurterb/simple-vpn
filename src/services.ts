import type { ApiServices } from './api-server.js';
import { ApiError } from './api-server.js';
import { loadOrCreateConfig, saveConfig } from './config-store.js';
import type { NodeConfig } from './config.js';
import {
  DEFAULT_SUBNET,
  ANCHOR_OVERLAY_IP,
  DEFAULT_LISTEN_PORT,
} from './config.js';
import { KeyManager } from './keys.js';
import {
  createSignedInvite,
  createSignedReply,
  decodeInvite,
  decodeReply,
  verifySignedInvite,
  computeInviteDigest,
  encodeInvite,
  encodeReply,
  validateInvitePayload,
  isInviteExpired,
  checkInviteSize,
  type InvitePayload,
  type SignedInvite,
  type SignedReply,
  type InviteEndpoint,
} from './invite.js';
import {
  InviteLifecycle,
  InviteConflictError,
  InviteLimitError,
} from './invite-lifecycle.js';
import { toBase64url, fromBase64url, deriveEd25519Public, deriveX25519Public } from './crypto.js';
import { WgManager } from './wgmanager.js';
import { OsNet } from './osnet.js';
import type { WgInterfaceConfig } from './wg-uapi.js';
import type { Logger } from './logger.js';
import type { PlatformInfo } from './platform.js';
import type { ConfigPaths } from './config-paths.js';
import { Journal } from './journal.js';
import { GamePortGuard, GAME_PORT } from './gameguard.js';
import { ListenerManager } from './listener.js';
import { PortMapper, type NatClient } from './port-mapper.js';
import { join } from 'node:path';

export interface ServiceDeps {
  paths: ConfigPaths;
  platform: PlatformInfo;
  logger: Logger;
}

export class VpnServices implements ApiServices {
  private config: NodeConfig;
  private readonly keyManager: KeyManager;
  private keys: ReturnType<KeyManager['loadKeys']> | null = null;
  private inviteLifecycle: InviteLifecycle | null = null;
  private readonly journal: Journal;
  private guard: GamePortGuard | null = null;
  private listener: ListenerManager | null = null;
  private wg: WgManager | null = null;
  private osnet: OsNet | null = null;
  private readonly startTime = Date.now();
  private static readonly IFACE_NAME = 'svpn0';

  constructor(private readonly deps: ServiceDeps) {
    const { config } = loadOrCreateConfig(deps.paths.configPath);
    this.config = config;
    this.keyManager = new KeyManager(deps.paths.wgKeyPath, deps.paths.identityKeyPath);
    this.journal = new Journal(deps.paths.journalPath);
    this.journal.load();
  }

  private ensureKeys() {
    if (!this.keys) {
      if (!this.keyManager.keysExist()) {
        this.keyManager.generateAndStoreKeys();
      }
      this.keys = this.keyManager.loadKeys();
    }
    return this.keys;
  }

  private ensureOsNet(): OsNet {
    if (!this.osnet) {
      this.osnet = new OsNet({ platform: this.deps.platform.os });
    }
    return this.osnet;
  }

  private async ensureInterface(): Promise<void> {
    if (this.wg?.isRunning()) return;

    const keys = this.ensureKeys();
    const osnet = this.ensureOsNet();
    const ifaceName = this.config.interfaceName ?? VpnServices.IFACE_NAME;

    this.wg = new WgManager({
      binaryPath: 'wireguard-go',
      interfaceName: ifaceName,
      platform: this.deps.platform.os,
      socketDir: this.deps.paths.configDir,
      kernelMode: this.deps.platform.os === 'linux',
    });

    await this.wg.start();

    const wgConfig: WgInterfaceConfig = {
      privateKey: toBase64url(keys.wg.privateKey),
      listenPort: this.config.listenPort ?? DEFAULT_LISTEN_PORT,
      peers: [],
    };
    await this.wg.setConfig(wgConfig);

    const overlayIP = this.config.overlayIP ?? ANCHOR_OVERLAY_IP;
    const subnet = this.config.subnetCIDR ?? DEFAULT_SUBNET;
    const ipWithPrefix = `${overlayIP}/${subnet.split('/')[1]}`;

    osnet.assignAddress(ifaceName, ipWithPrefix);
    osnet.linkUp(ifaceName);
    osnet.setMTU(ifaceName, 1280);
    osnet.addRoute(subnet, ifaceName);

    this.deps.logger.info(`Interface ${ifaceName} up: ${ipWithPrefix}`);
  }

  async stopInterface(): Promise<void> {
    if (this.wg) {
      await this.wg.stop();
      this.wg = null;
    }
  }

  private async ensureMemberInterface(invite: InvitePayload): Promise<void> {
    const keys = this.ensureKeys();
    const osnet = this.ensureOsNet();
    const ifaceName = this.config.interfaceName ?? 'svpn1';

    this.wg = new WgManager({
      binaryPath: 'wireguard-go',
      interfaceName: ifaceName,
      platform: this.deps.platform.os,
      socketDir: this.deps.paths.configDir,
      kernelMode: this.deps.platform.os === 'linux',
    });

    await this.wg.start();

    const anchorEndpoint = this.config.anchorEndpoint ?? '127.0.0.1:51820';
    const subnet = this.config.subnetCIDR ?? DEFAULT_SUBNET;

    const wgConfig: WgInterfaceConfig = {
      privateKey: toBase64url(keys.wg.privateKey),
      listenPort: this.config.listenPort ?? DEFAULT_LISTEN_PORT + 1,
      peers: [
        {
          publicKey: invite.anchorWgPubkey,
          endpoint: anchorEndpoint,
          allowedIPs: [subnet],
          persistentKeepaliveInterval: 25,
        },
      ],
    };
    await this.wg.setConfig(wgConfig);

    const overlayIP = this.config.overlayIP ?? '10.42.0.2';
    const prefixLen = subnet.split('/')[1] ?? '24';
    const ipWithPrefix = `${overlayIP}/${prefixLen}`;

    osnet.assignAddress(ifaceName, ipWithPrefix);
    osnet.linkUp(ifaceName);
    osnet.setMTU(ifaceName, 1280);
    osnet.addRoute(subnet, ifaceName);

    this.deps.logger.info(`Member interface ${ifaceName} up: ${ipWithPrefix}, peer=${anchorEndpoint}`);
  }

  private async addMemberPeer(peerWgPubkey: string, peerOverlayIP: string): Promise<void> {
    if (!this.wg?.isRunning()) {
      this.deps.logger.warn('Cannot add peer — WG interface not running');
      return;
    }

    await this.wg.addPeer({
      publicKey: peerWgPubkey,
      allowedIPs: [`${peerOverlayIP}/32`],
      persistentKeepaliveInterval: 25,
    });

    this.deps.logger.info(`Added peer ${peerWgPubkey} at ${peerOverlayIP}`);
  }

  private ensureInviteLifecycle(): InviteLifecycle {
    if (!this.inviteLifecycle) {
      const subnet = this.config.subnetCIDR ?? DEFAULT_SUBNET;
      const anchorIP = this.config.overlayIP ?? ANCHOR_OVERLAY_IP;
      const statePath = join(this.deps.paths.configDir, 'invite-state.json');
      this.inviteLifecycle = new InviteLifecycle(statePath, subnet, anchorIP);
      this.inviteLifecycle.load();
    }
    return this.inviteLifecycle;
  }

  async getStatus(): Promise<unknown> {
    const role = this.config.role;
    const serverAddress = this.config.overlayIP
      ? `${this.config.overlayIP}:${GAME_PORT}`
      : `${ANCHOR_OVERLAY_IP}:${GAME_PORT}`;

    const peers: unknown[] = [];

    return {
      status: 'ok',
      role,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      serverAddress,
      peers,
      guard: this.guard?.getStatus() ?? { applied: false, warnings: [] },
      listener: this.listener?.getStatus() ?? { state: 'disabled' },
    };
  }

  async createInvite(playerName: string): Promise<unknown> {
    if (this.config.role !== 'anchor') {
      throw new ApiError(400, 'NOT_ANCHOR', 'Only anchor nodes can create invites');
    }

    const keys = this.ensureKeys();
    const lifecycle = this.ensureInviteLifecycle();

    let record;
    try {
      record = lifecycle.createInvite(playerName);
    } catch (err) {
      if (err instanceof InviteLimitError) {
        throw new ApiError(429, 'RATE_LIMITED', err.message);
      }
      throw err;
    }

    const subnet = this.config.subnetCIDR ?? DEFAULT_SUBNET;
    const listenPort = this.config.listenPort ?? DEFAULT_LISTEN_PORT;

    const endpoints: InviteEndpoint[] = [
      { host: '127.0.0.1', port: listenPort, type: 'wan', family: 4 },
    ];

    const payload: InvitePayload = {
      v: 1,
      netID: this.config.netID ?? 'default',
      anchorName: this.config.name ?? 'anchor',
      anchorWgPubkey: toBase64url(deriveX25519Public(keys.wg.privateKey)),
      anchorSigPubkey: toBase64url(deriveEd25519Public(keys.identity.privateKey)),
      endpoints,
      assignedIP: record.assignedIP,
      subnetCIDR: subnet,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      inviteID: record.inviteID,
    };

    const signed = createSignedInvite(payload, keys.identity.privateKey);
    const digest = computeInviteDigest(signed);
    lifecycle.bindDigest(record.inviteID, digest);

    const encoded = encodeInvite(signed);
    return {
      inviteID: record.inviteID,
      invite: encoded,
      assignedIP: record.assignedIP,
      expiresAt: record.expiresAt,
    };
  }

  async importInvite(invite: string): Promise<unknown> {
    if (this.config.role !== null && this.config.role !== 'member') {
      throw new ApiError(400, 'NOT_MEMBER', 'Only member nodes can import invites');
    }

    if (!checkInviteSize(invite)) {
      throw new ApiError(400, 'INVITE_TOO_LARGE', 'Invite code exceeds maximum size');
    }

    let signed: SignedInvite;
    try {
      signed = decodeInvite(invite);
    } catch {
      throw new ApiError(400, 'INVALID_INVITE', 'Could not decode invite');
    }

    const errors = validateInvitePayload(signed.payload);
    if (errors.length > 0) {
      throw new ApiError(400, 'INVALID_INVITE', errors.join('; '));
    }

    if (isInviteExpired(signed.payload)) {
      throw new ApiError(410, 'INVITE_EXPIRED', 'Invite has expired');
    }

    const keys = this.ensureKeys();

    const anchorSigPubkey = fromBase64url(signed.payload.anchorSigPubkey);
    if (!verifySignedInvite(signed, anchorSigPubkey)) {
      throw new ApiError(400, 'INVALID_SIGNATURE', 'Invite signature verification failed');
    }

    this.config.role = 'member';
    this.config.netID = signed.payload.netID;
    this.config.name = signed.payload.anchorName;
    this.config.overlayIP = signed.payload.assignedIP;
    this.config.subnetCIDR = signed.payload.subnetCIDR;
    this.config.anchorSigPubkey = signed.payload.anchorSigPubkey;
    this.config.anchorWgPubkey = signed.payload.anchorWgPubkey;
    const ep = signed.payload.endpoints[0];
    this.config.anchorEndpoint = ep ? `${ep.host}:${ep.port}` : null;
    if (this.config.interfaceName === null) {
      this.config.interfaceName = 'svpn1';
    }
    if (this.config.listenPort === null) {
      this.config.listenPort = DEFAULT_LISTEN_PORT + 1;
    }
    saveConfig(this.deps.paths.configPath, this.config);

    // Bring up member WG interface with anchor as peer
    await this.ensureMemberInterface(signed.payload);

    const playerWgPubkey = toBase64url(deriveX25519Public(keys.wg.privateKey));
    const playerSigPubkey = toBase64url(deriveEd25519Public(keys.identity.privateKey));

    const replyPayload = {
      v: 1 as const,
      inviteDigest: computeInviteDigest(signed),
      playerName: 'member',
      playerWgPubkey,
      playerSigPubkey,
    };

    const signedReply = createSignedReply(replyPayload, keys.identity.privateKey);

    return { reply: encodeReply(signedReply) };
  }

  async importReply(reply: string): Promise<unknown> {
    if (this.config.role !== 'anchor') {
      throw new ApiError(400, 'NOT_ANCHOR', 'Only anchor nodes can import replies');
    }

    let signed: SignedReply;
    try {
      signed = decodeReply(reply);
    } catch {
      throw new ApiError(400, 'INVALID_REPLY', 'Could not decode reply');
    }

    const lifecycle = this.ensureInviteLifecycle();

    let record;
    try {
      record = lifecycle.consumeByDigest(signed.payload.inviteDigest);
    } catch (err) {
      if (err instanceof InviteConflictError) {
        throw new ApiError(409, 'CONFLICT', err.message);
      }
      throw err;
    }

    // Add member as peer on anchor's WG interface
    await this.addMemberPeer(signed.payload.playerWgPubkey, record.assignedIP);

    return {
      member: {
        name: signed.payload.playerName,
        overlayIP: record.assignedIP,
        wgPubkey: signed.payload.playerWgPubkey,
      },
    };
  }

  async revokeInvite(inviteID: string): Promise<void> {
    if (this.config.role !== 'anchor') {
      throw new ApiError(400, 'NOT_ANCHOR', 'Only anchor nodes can revoke invites');
    }
    const lifecycle = this.ensureInviteLifecycle();
    try {
      lifecycle.revoke(inviteID);
    } catch (err) {
      if (err instanceof InviteConflictError) {
        throw new ApiError(409, 'CONFLICT', err.message);
      }
      throw err;
    }
  }

  async removePeer(wgPubkey: string): Promise<void> {
    this.deps.logger.info(`Removing peer ${wgPubkey}`);
  }

  async probe(): Promise<unknown> {
    return {
      tunnel: true,
      tcp: false,
      udp: false,
      detail: 'Diagnostics not fully implemented in this mode.',
    };
  }

  async setListener(enabled: boolean): Promise<unknown> {
    if (!this.listener) {
      const natClient: NatClient = {
        async getExternalIP() { throw new Error('No NAT client available'); },
        async addPortMapping() { throw new Error('No NAT client available'); },
        async deletePortMapping() {},
        async getMappings() { return []; },
      };
      this.listener = new ListenerManager(new PortMapper(natClient, this.journal));
    }

    if (enabled) {
      const result = await this.listener.enable(
        'optional',
        this.config.overlayIP ?? ANCHOR_OVERLAY_IP,
        this.config.listenPort ?? DEFAULT_LISTEN_PORT,
        this.config.listenPort ?? DEFAULT_LISTEN_PORT,
        true,
      );
      return result;
    } else {
      await this.listener.disable();
      return this.listener.getStatus();
    }
  }

  async setGuard(consented: boolean): Promise<unknown> {
    if (!this.guard) {
      this.guard = new GamePortGuard(
        this.deps.platform.os,
        this.config.subnetCIDR ?? DEFAULT_SUBNET,
        this.journal,
      );
    }
    return this.guard.apply(consented);
  }

  async getSettings(): Promise<unknown> {
    return {
      name: this.config.name,
      role: this.config.role,
      listenPort: this.config.listenPort,
      uiPort: this.config.uiPort,
      subnetCIDR: this.config.subnetCIDR,
      listenerEnabled: this.config.listenerEnabled,
    };
  }

  async patchSettings(patch: Record<string, unknown>): Promise<unknown> {
    if (typeof patch['name'] === 'string') this.config.name = patch['name'];
    if (typeof patch['listenPort'] === 'number') this.config.listenPort = patch['listenPort'];
    if (typeof patch['uiPort'] === 'number') this.config.uiPort = patch['uiPort'];
    if (typeof patch['subnetCIDR'] === 'string') this.config.subnetCIDR = patch['subnetCIDR'];
    if (typeof patch['listenerEnabled'] === 'boolean') this.config.listenerEnabled = patch['listenerEnabled'];

    if (this.config.role === null) {
      this.config.role = 'anchor';
    }
    if (this.config.overlayIP === null) {
      this.config.overlayIP = ANCHOR_OVERLAY_IP;
    }
    if (this.config.subnetCIDR === null) {
      this.config.subnetCIDR = DEFAULT_SUBNET;
    }
    if (this.config.netID === null) {
      this.config.netID = `net-${Date.now().toString(36)}`;
    }

    saveConfig(this.deps.paths.configPath, this.config);

    if (this.config.role === 'anchor') {
      await this.ensureInterface();
    }

    return {
      name: this.config.name,
      role: this.config.role,
      listenPort: this.config.listenPort,
      uiPort: this.config.uiPort,
      subnetCIDR: this.config.subnetCIDR,
      listenerEnabled: this.config.listenerEnabled,
    };
  }
}
