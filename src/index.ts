#!/usr/bin/env node

import { runPreflight } from './preflight.js';
import { SingleInstanceLock } from './lock.js';
import { Logger } from './logger.js';
import { mkdirSync, existsSync } from 'node:fs';

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

async function main(): Promise<void> {
  const state = await bootstrap();

  // VALIDATE[major] F6 (PRD architecture): bootstrap stub — API server, wg device (wgmanager),
  // reconciler, control channel, diagnostics, recovery sweep never started. Daemon does nothing.
  // fix: wire modules here (load keys/config -> sweep -> start wg -> reconciler -> api -> control).
  state.logger.info('Daemon initialized. API server and supervisor would start here.');

  process.on('SIGINT', () => {
    state.logger.info('Received SIGINT, shutting down.');
    state.lock.release();
    state.logger.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    state.logger.info('Received SIGTERM, shutting down.');
    state.lock.release();
    state.logger.close();
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
