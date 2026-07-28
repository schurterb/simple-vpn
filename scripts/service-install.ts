#!/usr/bin/env node

import { getPlatformInfo } from '../src/platform.js';

// VALIDATE[major] F16 (PRD CF7): stub — prints text, never calls ServiceManager. Same for service-uninstall.
// Also package.json points at dist/scripts/* which tsc may not emit (scripts/ outside rootDir) — verify build.
// fix: instantiate ServiceManager per platform and call install(); use node-windows on win32 (dep absent).
const platform = getPlatformInfo();

switch (platform.os) {
  case 'linux':
    console.log('Service install for Linux: systemd unit installation would go here.');
    break;
  case 'darwin':
    console.log('Service install for macOS: launchd plist installation would go here.');
    break;
  case 'win32':
    console.log('Service install for Windows: node-windows service registration would go here.');
    break;
}
