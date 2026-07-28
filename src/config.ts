export type NodeRole = 'anchor' | 'member';

export interface Endpoint {
  host: string;
  port: number;
  family?: 4 | 6;
}

export interface NodeConfig {
  schemaVersion: number;
  netID: string | null;
  role: NodeRole | null;
  listenerEnabled: boolean;
  name: string | null;
  overlayIP: string | null;
  subnetCIDR: string | null;
  listenPort: number | null;
  uiPort: number;
  anchorSigPubkey: string | null;
  interfaceName: string | null;
  anchorWgPubkey: string | null;
  anchorEndpoint: string | null;
  createdAt: number;
  updatedAt: number;
}

export const CURRENT_SCHEMA_VERSION = 1;
export const DEFAULT_UI_PORT = 8420;
export const DEFAULT_LISTEN_PORT = 51820;
export const DEFAULT_SUBNET = '10.42.0.0/24';
export const ANCHOR_OVERLAY_IP = '10.42.0.1';

export function createDefaultConfig(): NodeConfig {
  const now = Math.floor(Date.now() / 1000);
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    netID: null,
    role: null,
    listenerEnabled: false,
    name: null,
    overlayIP: null,
    subnetCIDR: null,
    listenPort: null,
    uiPort: DEFAULT_UI_PORT,
    anchorSigPubkey: null,
    interfaceName: null,
    anchorWgPubkey: null,
    anchorEndpoint: null,
    createdAt: now,
    updatedAt: now,
  };
}

export interface ValidationError {
  field: string;
  message: string;
}

export function validateConfig(config: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (typeof config !== 'object' || config === null) {
    return [{ field: 'root', message: 'Config must be a JSON object' }];
  }

  const c = config as Record<string, unknown>;

  if (typeof c['schemaVersion'] !== 'number' || !Number.isInteger(c['schemaVersion'])) {
    errors.push({ field: 'schemaVersion', message: 'schemaVersion must be an integer' });
  }

  if (c['role'] !== null && c['role'] !== 'anchor' && c['role'] !== 'member') {
    errors.push({ field: 'role', message: 'role must be null, "anchor", or "member"' });
  }

  if (c['listenerEnabled'] !== undefined && typeof c['listenerEnabled'] !== 'boolean') {
    errors.push({ field: 'listenerEnabled', message: 'listenerEnabled must be boolean' });
  }

  if (typeof c['uiPort'] !== 'number' || c['uiPort'] < 1 || c['uiPort'] > 65535) {
    errors.push({ field: 'uiPort', message: 'uiPort must be between 1 and 65535' });
  }

  if (c['listenPort'] !== null && c['listenPort'] !== undefined) {
    if (typeof c['listenPort'] !== 'number' || c['listenPort'] < 1 || c['listenPort'] > 65535) {
      errors.push({ field: 'listenPort', message: 'listenPort must be between 1 and 65535 or null' });
    }
  }

  if (c['name'] !== null && c['name'] !== undefined) {
    if (typeof c['name'] !== 'string' || c['name'].length < 1 || c['name'].length > 32) {
      errors.push({ field: 'name', message: 'name must be 1-32 characters or null' });
    }
  }

  if (c['subnetCIDR'] !== null && c['subnetCIDR'] !== undefined) {
    if (typeof c['subnetCIDR'] !== 'string') {
      errors.push({ field: 'subnetCIDR', message: 'subnetCIDR must be a string or null' });
    }
  }

  if (c['overlayIP'] !== null && c['overlayIP'] !== undefined) {
    if (typeof c['overlayIP'] !== 'string') {
      errors.push({ field: 'overlayIP', message: 'overlayIP must be a string or null' });
    }
  }

  if (c['anchorSigPubkey'] !== null && c['anchorSigPubkey'] !== undefined) {
    if (typeof c['anchorSigPubkey'] !== 'string') {
      errors.push({ field: 'anchorSigPubkey', message: 'anchorSigPubkey must be a string or null' });
    }
  }

  if (typeof c['createdAt'] !== 'number' || !Number.isInteger(c['createdAt'])) {
    errors.push({ field: 'createdAt', message: 'createdAt must be an integer Unix timestamp' });
  }

  if (typeof c['updatedAt'] !== 'number' || !Number.isInteger(c['updatedAt'])) {
    errors.push({ field: 'updatedAt', message: 'updatedAt must be an integer Unix timestamp' });
  }

  return errors;
}

export function assertValidConfig(config: unknown): NodeConfig {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    const messages = errors.map((e) => `${e.field}: ${e.message}`).join('; ');
    throw new Error(`Config validation failed: ${messages}`);
  }
  return config as NodeConfig;
}
