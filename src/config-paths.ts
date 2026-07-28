import { join } from 'node:path';
import type { SupportedPlatform } from './platform.js';

export interface ConfigPaths {
  configDir: string;
  logDir: string;
  journalPath: string;
  configPath: string;
  wgKeyPath: string;
  identityKeyPath: string;
  lockFile: string;
  sessionDir: string;
}

export function getConfigPaths(
  platform: SupportedPlatform,
  baseDir?: string,
): ConfigPaths {
  const configDir = baseDir ?? defaultConfigDir(platform);
  const logDir = join(configDir, 'logs');
  const sessionDir = join(configDir, 'sessions');

  return {
    configDir,
    logDir,
    journalPath: join(configDir, 'journal.jsonl'),
    configPath: join(configDir, 'config.json'),
    wgKeyPath: join(configDir, 'wg.key'),
    identityKeyPath: join(configDir, 'identity.key'),
    lockFile: join(configDir, 'simple-vpn.lock'),
    sessionDir,
  };
}

function defaultConfigDir(platform: SupportedPlatform): string {
  switch (platform) {
    case 'linux':
      return '/etc/simple-vpn';
    case 'darwin':
      return '/Library/Application Support/simple-vpn';
    case 'win32': {
      const programData = process.env['ProgramData'] ?? 'C:\\ProgramData';
      return join(programData, 'simple-vpn');
    }
  }
}
