import type { PortMapper } from './port-mapper.js';

export type ListenerRole = 'anchor-mandatory' | 'optional';
export type ListenerState = 'disabled' | 'mapping' | 'verifying' | 'active' | 'failed';

export interface ListenerStatus {
  state: ListenerState;
  role: ListenerRole;
  externalIP: string | null;
  externalPort: number | null;
  verified: boolean;
  /** True only after reachability is verified. Roster advertises the endpoint iff advertised. */
  advertised: boolean;
  warnings: string[];
  manualGuide: string | null;
}

/**
 * Anchor-side reachability probe (PRD CF4): returns true iff a WG handshake is observed
 * against the proposed external endpoint. Injected so it can be driven over the control
 * channel (POST /listener/proposal) in production and mocked in tests.
 */
export type ReachabilityVerifier = (externalIP: string, externalPort: number) => Promise<boolean>;

const UNVERIFIED_GUIDE =
  'Listener endpoint could not be verified (no inbound WG handshake). ' +
  'Check your router port-forward for the UDP port, then retry. ' +
  'You can still play as a client without a listener.';

export class ListenerManager {
  private status: ListenerStatus = {
    state: 'disabled',
    role: 'optional',
    externalIP: null,
    externalPort: null,
    verified: false,
    advertised: false,
    warnings: [],
    manualGuide: null,
  };

  private lastExternalIP: string | null = null;

  constructor(
    private readonly portMapper: PortMapper,
    // Default: cannot verify locally -> never advertise (fail-closed, PRD verified-before-advertised).
    private readonly verifier: ReachabilityVerifier = async () => false,
  ) {}

  async enable(
    role: ListenerRole,
    internalIP: string,
    internalPort: number,
    externalPort: number,
    consented: boolean,
  ): Promise<ListenerStatus> {
    this.status = {
      ...this.status,
      state: 'mapping',
      role,
      warnings: [],
    };

    const result = await this.portMapper.mapPort(
      internalIP,
      internalPort,
      externalPort,
      'udp',
      consented,
    );

    if (!result.success) {
      this.status = {
        state: 'failed',
        role,
        externalIP: result.externalIP,
        externalPort: null,
        verified: false,
        advertised: false,
        warnings: [result.error],
        manualGuide: result.manualGuide,
      };
      return this.status;
    }

    this.status = {
      ...this.status,
      state: 'verifying',
      externalIP: result.externalIP,
      externalPort: externalPort,
    };

    if (result.externalIP && this.lastExternalIP && result.externalIP !== this.lastExternalIP) {
      this.status.warnings.push(
        `External IP changed from ${this.lastExternalIP} to ${result.externalIP}. Re-proposing listener.`,
      );
    }
    this.lastExternalIP = result.externalIP;

    const verified = await this.verifier(result.externalIP!, externalPort);

    if (verified) {
      this.status = {
        ...this.status,
        state: 'active',
        verified: true,
        advertised: true,
      };
      return this.status;
    }

    // Verified-before-advertised (PRD CF4): an unverified endpoint is NEVER advertised.
    // Roll back the port mapping and surface guidance regardless of role.
    await this.portMapper.unmapPort();
    const roleHint =
      role === 'anchor-mandatory'
        ? 'The anchor MUST be reachable — remote play is unavailable until this succeeds.'
        : 'This listener will not be advertised to peers.';
    this.status = {
      ...this.status,
      state: 'failed',
      verified: false,
      advertised: false,
      externalPort: null,
      warnings: [...this.status.warnings, `Reachability verification failed. ${roleHint}`],
      manualGuide: UNVERIFIED_GUIDE,
    };
    return this.status;
  }

  async disable(): Promise<void> {
    await this.portMapper.unmapPort();
    this.status = {
      state: 'disabled',
      role: this.status.role,
      externalIP: null,
      externalPort: null,
      verified: false,
      advertised: false,
      warnings: [],
      manualGuide: null,
    };
  }

  getStatus(): ListenerStatus {
    return { ...this.status };
  }

  shouldRePropose(currentExternalIP: string): boolean {
    return this.lastExternalIP !== null && currentExternalIP !== this.lastExternalIP;
  }
}
