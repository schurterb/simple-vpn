import {
  type NodeConfig,
  CURRENT_SCHEMA_VERSION,
  createDefaultConfig,
  assertValidConfig,
} from './config.js';
import { readJsonFile, writeJsonAtomically, fileExists } from './atomic-io.js';

export interface MigrationResult {
  config: NodeConfig;
  migrated: boolean;
  fromVersion: number;
  toVersion: number;
}

type MigrationFn = (config: Record<string, unknown>) => Record<string, unknown>;

const migrations: Map<number, MigrationFn> = new Map();

export function migrateConfig(raw: unknown): MigrationResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Config is not a JSON object');
  }

  const obj = raw as Record<string, unknown>;
  const version = typeof obj['schemaVersion'] === 'number' ? obj['schemaVersion'] : 0;

  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Config schemaVersion ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}. ` +
        'Upgrade simple-vpn to the latest version.',
    );
  }

  let current = obj;
  let currentVersion = version;
  let migrated = false;

  while (currentVersion < CURRENT_SCHEMA_VERSION) {
    const fn = migrations.get(currentVersion);
    if (!fn) {
      throw new Error(`No migration path from schemaVersion ${currentVersion}`);
    }
    current = fn(current);
    currentVersion = current['schemaVersion'] as number;
    migrated = true;
  }

  const config = assertValidConfig(current);
  return {
    config,
    migrated,
    fromVersion: version,
    toVersion: CURRENT_SCHEMA_VERSION,
  };
}

export function loadOrCreateConfig(configPath: string): {
  config: NodeConfig;
  created: boolean;
} {
  if (!fileExists(configPath)) {
    const config = createDefaultConfig();
    writeJsonAtomically(configPath, config);
    return { config, created: true };
  }

  const raw = readJsonFile<unknown>(configPath);
  const result = migrateConfig(raw);
  const config = result.config;

  if (result.migrated) {
    config.updatedAt = Math.floor(Date.now() / 1000);
    writeJsonAtomically(configPath, config);
  }

  return { config, created: false };
}

export function saveConfig(configPath: string, config: NodeConfig): void {
  config.schemaVersion = CURRENT_SCHEMA_VERSION;
  config.updatedAt = Math.floor(Date.now() / 1000);
  assertValidConfig(config);
  writeJsonAtomically(configPath, config);
}
