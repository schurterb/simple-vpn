#!/usr/bin/env node

import { getPlatformInfo } from '../src/platform.js';

const platform = getPlatformInfo();

switch (platform.os) {
  case 'linux':
    console.log('Service uninstall for Linux: systemd unit removal would go here.');
    break;
  case 'darwin':
    console.log('Service uninstall for macOS: launchd plist removal would go here.');
    break;
  case 'win32':
    console.log('Service uninstall for Windows: node-windows service removal would go here.');
    break;
}
