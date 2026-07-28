#!/usr/bin/env node

import { runPreflight } from './preflight.js';
import { SingleInstanceLock } from './lock.js';
import { Logger } from './logger.js';
import { ApiServer } from './api-server.js';
import { VpnServices } from './services.js';
import { loadOrCreateConfig } from './config-store.js';
import { DEFAULT_UI_PORT } from './config.js';
import { mkdirSync, existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { join } from 'node:path';

export interface DaemonState {
  preflight: ReturnType<typeof runPreflight>;
  logger: Logger;
  lock: SingleInstanceLock;
  isFirstRun: boolean;
}

export async function bootstrap(baseDir?: string): Promise<DaemonState> {
  const preflight = runPreflight(baseDir);

  if (!preflight.ok) {
    for (const err of preflight.errors) {
      process.stderr.write(`ERROR: ${err}\n`);
    }
    process.exit(1);
  }

  for (const warn of preflight.warnings) {
    process.stderr.write(`WARNING: ${warn}\n`);
  }

  mkdirSync(preflight.paths.configDir, { recursive: true });
  mkdirSync(preflight.paths.logDir, { recursive: true });
  mkdirSync(preflight.paths.sessionDir, { recursive: true });

  const logger = new Logger(preflight.paths.logDir);
  logger.init();

  const lock = new SingleInstanceLock(preflight.paths.lockFile);
  if (!lock.acquire()) {
    process.stderr.write(
      'ERROR: Another instance of simple-vpn is already running. If this is incorrect, remove the lock file:\n' +
        `  ${preflight.paths.lockFile}\n`,
    );
    process.exit(1);
  }

  const isFirstRun = !existsSync(preflight.paths.configPath);

  logger.info(
    `Daemon started: platform=${preflight.platform.os}/${preflight.platform.arch} node=${preflight.nodeVersion} elevated=${preflight.platform.isElevated} firstRun=${isFirstRun}`,
  );

  return { preflight, logger, lock, isFirstRun };
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      process.stderr.write(`Could not open browser automatically. Open ${url} manually.\n`);
    }
  });
}

async function main(): Promise<void> {
  const baseDir = process.argv[2];
  const state = await bootstrap(baseDir);

  const { config } = loadOrCreateConfig(state.preflight.paths.configPath);
  const uiPort = config.uiPort ?? DEFAULT_UI_PORT;

  const wwwDir = join(__dirname, '..', '..', 'www');

  const services = new VpnServices({
    paths: state.preflight.paths,
    platform: state.preflight.platform,
    logger: state.logger,
  });

  const apiServer = new ApiServer({
    port: uiPort,
    wwwDir,
    canonicalHost: `127.0.0.1:${uiPort}`,
    services,
  });

  await apiServer.start();

  const url = apiServer.address;
  process.stdout.write(`\n  simple-vpn UI: ${url}\n\n`);
  state.logger.info(`API server listening on ${url}`);

  openBrowser(url);

  process.on('SIGINT', () => {
    state.logger.info('Received SIGINT, shutting down.');
    void apiServer.stop().then(() => services.stopInterface()).then(() => {
      state.lock.release();
      state.logger.close();
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    state.logger.info('Received SIGTERM, shutting down.');
    void apiServer.stop().then(() => services.stopInterface()).then(() => {
      state.lock.release();
      state.logger.close();
      process.exit(0);
    });
  });
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
