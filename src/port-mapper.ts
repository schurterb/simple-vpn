import type { Journal } from './journal.js';

// VALIDATE[minor] F13 (PRD CF4): tag must be "simple-vpn:<nodeID>" for ownership scoping.
export const MAPPING_TAG = 'simple-vpn';
export const LEASE_RENEWAL_MARGIN_SEC = 300;

export interface PortMapping {
  externalPort: number;
  internalPort: number;
  protocol: 'tcp' | 'udp';
  internalIP: string;
  leaseDurationSec: number;
  tag: string;
}

export interface MappingResult {
  success: boolean;
  mapping: PortMapping | null;
  externalIP: string | null;
  error: string;
  manualGuide: string | null;
}

export type NatClient = {
  getExternalIP(): Promise<string>;
  addPortMapping(mapping: PortMapping): Promise<void>;
  deletePortMapping(externalPort: number, protocol: 'tcp' | 'udp'): Promise<void>;
  getMappings(): Promise<PortMapping[]>;
};

export class PortMapper {
  private currentMapping: PortMapping | null = null;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly natClient: NatClient,
    private readonly journal: Journal,
  ) {}

  async mapPort(
    internalIP: string,
    internalPort: number,
    externalPort: number,
    protocol: 'tcp' | 'udp',
    consented: boolean,
  ): Promise<MappingResult> {
    if (!consented) {
      return {
        success: false,
        mapping: null,
        externalIP: null,
        error: 'Port mapping not consented',
        manualGuide: this.getManualGuide(internalIP, internalPort, externalPort, protocol),
      };
    }

    try {
      const externalIP = await this.natClient.getExternalIP();

      // VALIDATE[minor] F13 (PRD CF4): returned external IP must be validated as PUBLIC
      // (malicious/absent gateway defense); retry cap 3 then manual guide; fallback to
      // router-assigned external port when requested port unavailable — all missing. fix per CF4.
      const existing = await this.natClient.getMappings();
      const conflict = existing.find(
        (m) => m.externalPort === externalPort && m.tag !== MAPPING_TAG,
      );

      if (conflict) {
        return {
          success: false,
          mapping: null,
          externalIP,
          error: `Port ${externalPort} already mapped by another application (tag: ${conflict.tag})`,
          manualGuide: this.getManualGuide(internalIP, internalPort, externalPort, protocol),
        };
      }

      const mapping: PortMapping = {
        externalPort,
        internalPort,
        protocol,
        internalIP,
        leaseDurationSec: 3600,
        tag: MAPPING_TAG,
      };

      this.journal.append(
        'mapping',
        `upnp-${externalPort}-${protocol}`,
        'create',
        { externalPort, internalPort, protocol, internalIP, tag: MAPPING_TAG },
      );

      await this.natClient.addPortMapping(mapping);
      this.currentMapping = mapping;

      this.scheduleRenewal();

      return {
        success: true,
        mapping,
        externalIP,
        error: '',
        manualGuide: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        mapping: null,
        externalIP: null,
        error: `UPnP/NAT-PMP mapping failed: ${msg}`,
        manualGuide: this.getManualGuide(internalIP, internalPort, externalPort, protocol),
      };
    }
  }

  async unmapPort(): Promise<void> {
    if (this.renewTimer) {
      clearTimeout(this.renewTimer);
      this.renewTimer = null;
    }

    if (!this.currentMapping) return;

    const entries = this.journal.getEntriesByType('mapping');
    for (const entry of entries) {
      if (entry.identity.startsWith('upnp-')) {
        try {
          const externalPort = entry.attributes['externalPort'] as number;
          const protocol = entry.attributes['protocol'] as 'tcp' | 'udp';
          await this.natClient.deletePortMapping(externalPort, protocol);
          this.journal.updateState(entry.id, 'removed');
          this.journal.removeEntry(entry.id);
        } catch {
          // best effort
        }
      }
    }

    this.currentMapping = null;
  }

  getCurrentMapping(): PortMapping | null {
    return this.currentMapping;
  }

  // VALIDATE[minor] F13 (PRD CF4): renewal must occur at half-life (1800 s for 3600 s lease),
  // not lease-300 s. fix: leaseDurationSec / 2.
  private scheduleRenewal(): void {
    const renewMs = (this.currentMapping!.leaseDurationSec - LEASE_RENEWAL_MARGIN_SEC) * 1000;
    this.renewTimer = setTimeout(async () => {
      if (!this.currentMapping) return;
      try {
        await this.natClient.addPortMapping(this.currentMapping!);
      } catch {
        // renewal failed, will retry on next cycle
      }
    }, renewMs);
    this.renewTimer.unref();
  }

  private getManualGuide(internalIP: string, internalPort: number, externalPort: number, protocol: 'tcp' | 'udp'): string {
    return `Automatic port mapping failed. Please manually configure port forwarding on your router:\n` +
      `  Forward ${protocol.toUpperCase()} port ${externalPort} → ${internalIP}:${internalPort}\n` +
      `  Protocol: ${protocol.toUpperCase()}\n` +
      `  After configuring, click "Verify Reachability" in the UI.`;
  }
}
