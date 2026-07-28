#!/usr/bin/env node

import { runPreflight } from '../src/preflight.js';
import { SingleInstanceLock } from '../src/lock.js';

const preflight = runPreflight();

if (!preflight.ok) {
  for (const err of preflight.errors) {
    process.stderr.write(`ERROR: ${err}\n`);
  }
  process.exit(1);
}

const pid = SingleInstanceLock.readPid(preflight.paths.lockFile);

if (pid === null) {
  process.stderr.write('No running simple-vpn daemon found (lock file missing or invalid).\n');
  process.exit(1);
}

try {
  process.kill(pid, 'SIGTERM');
  process.stdout.write(`Sent SIGTERM to simple-vpn daemon (PID ${pid}).\n`);
} catch {
  process.stderr.write(`Failed to signal PID ${pid}. Process may have already exited.\n`);
  process.exit(1);
}
