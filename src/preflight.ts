import { getPlatformInfo, type PlatformInfo } from './platform.js';
import { getConfigPaths, type ConfigPaths } from './config-paths.js';

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  platform: PlatformInfo;
  paths: ConfigPaths;
  nodeVersion: string;
}

const MIN_NODE_MAJOR = 20;

export function checkNodeVersion(version: string): { ok: boolean; major: number } {
  const match = /^v?(\d+)/.exec(version);
  const major = match ? parseInt(match[1]!, 10) : 0;
  return { ok: major >= MIN_NODE_MAJOR, major };
}

export function runPreflight(baseDir?: string): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const nodeCheck = checkNodeVersion(process.version);
  if (!nodeCheck.ok) {
    errors.push(
      `Node.js >=${MIN_NODE_MAJOR} required, found ${process.version} (major ${nodeCheck.major}). Please upgrade Node.js.`,
    );
  }

  let platform: PlatformInfo;
  try {
    platform = getPlatformInfo();
  } catch (err) {
    throw err;
  }

  if (!platform.isElevated) {
    warnings.push(
      'Daemon is not running with elevated privileges. Interface creation requires root/Administrator. Use `npm run service:install` for set-and-forget operation.',
    );
  }

  const paths = getConfigPaths(platform.os, baseDir);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    platform,
    paths,
    nodeVersion: process.version,
  };
}
