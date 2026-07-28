#!/usr/bin/env node

import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

function run(cmd: string, label: string): void {
  process.stdout.write(`  ${label}... `);
  try {
    execSync(cmd, { stdio: 'pipe', cwd: join(__dirname, '..') });
    process.stdout.write('done\n');
  } catch (err) {
    process.stdout.write('FAILED\n');
    throw err;
  }
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`${isWin ? 'where' : 'which'} ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function checkNode(): void {
  const major = parseInt(process.version.replace(/^v/, '').split('.')[0]!, 10);
  if (major < 20) {
    process.stderr.write(`\n  ERROR: Node.js >= 20 required (found ${process.version}).\n`);
    process.stderr.write(`  Install from: https://nodejs.org/\n\n`);
    process.exit(1);
  }
}

function ensureWireGuard(): void {
  if (commandExists('wg')) return;

  process.stdout.write('  WireGuard not found. Installing... ');

  try {
    if (isLinux) {
      // Try apt, then dnf, then pacman
      if (commandExists('apt-get')) {
        execSync('sudo apt-get update -qq && sudo apt-get install -y -qq wireguard-tools', { stdio: 'pipe' });
      } else if (commandExists('dnf')) {
        execSync('sudo dnf install -y wireguard-tools', { stdio: 'pipe' });
      } else if (commandExists('pacman')) {
        execSync('sudo pacman -S --noconfirm wireguard-tools', { stdio: 'pipe' });
      } else {
        throw new Error('No supported package manager found');
      }
    } else if (isMac) {
      if (!commandExists('brew')) {
        throw new Error('Homebrew not installed. Install from https://brew.sh');
      }
      execSync('brew install wireguard-tools', { stdio: 'pipe' });
    } else if (isWin) {
      // Check if WireGuard is installed in default location
      const wgPath = 'C:\\Program Files\\WireGuard\\wg.exe';
      if (!existsSync(wgPath)) {
        process.stdout.write('\n');
        process.stderr.write('\n  WireGuard for Windows not found.\n');
        process.stderr.write('  Download and install from: https://www.wireguard.com/install/\n');
        process.stderr.write('  Then re-run setup.\n\n');
        process.exit(1);
      }
      // Add to PATH for this session
      process.env['PATH'] = `C:\\Program Files\\WireGuard;${process.env['PATH']}`;
    }
    process.stdout.write('done\n');
  } catch (err) {
    process.stdout.write('FAILED\n');
    throw err;
  }
}

function startDaemon(): void {
  const scriptPath = join(__dirname, '..', 'dist', 'src', 'index.js');

  if (!existsSync(scriptPath)) {
    process.stderr.write('\n  ERROR: Build output not found. Run "npm run build" first.\n\n');
    process.exit(1);
  }

  process.stdout.write('\n  Starting simple-vpn daemon...\n');

  if (isWin) {
    // On Windows, we need admin. Relaunch elevated.
    // If already admin, just run it.
    const elevated = process.env['USERPROFILE']?.toLowerCase().includes('system32') ?? false;
    if (elevated) {
      spawn('node', [scriptPath], { stdio: 'inherit' });
    } else {
      // Use PowerShell to relaunch as admin
      const psCmd = `Start-Process node -ArgumentList '${scriptPath}' -Verb RunAs`;
      execSync(`powershell -Command "${psCmd}"`, { stdio: 'inherit' });
    }
  } else {
    // Linux/macOS: use sudo
    const child = spawn('sudo', ['node', scriptPath], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
  }
}

// Main
process.stdout.write('\n  simple-vpn setup\n  ═══════════════\n\n');

checkNode();
run('npm install', 'Installing dependencies');
run('npm run build', 'Compiling TypeScript');
ensureWireGuard();

process.stdout.write('\n  Setup complete!\n');
startDaemon();
