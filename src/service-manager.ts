import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { SupportedPlatform } from './platform.js';

export type ServiceState = 'installed' | 'not-installed' | 'error';

export interface ServiceInstallResult {
  state: ServiceState;
  message: string;
}

export interface ServiceConfig {
  name: string;
  displayName: string;
  description: string;
  execPath: string;
  workingDir: string;
  user?: string;
}

export class ServiceManager {
  constructor(
    private readonly platform: SupportedPlatform,
    private readonly config: ServiceConfig,
  ) {}

  install(): ServiceInstallResult {
    switch (this.platform) {
      case 'linux':
        return this.installSystemd();
      case 'darwin':
        return this.installLaunchd();
      case 'win32':
        return this.installWindows();
    }
  }

  uninstall(): ServiceInstallResult {
    switch (this.platform) {
      case 'linux':
        return this.uninstallSystemd();
      case 'darwin':
        return this.uninstallLaunchd();
      case 'win32':
        return this.uninstallWindows();
    }
  }

  isInstalled(): boolean {
    switch (this.platform) {
      case 'linux':
        return existsSync(`/etc/systemd/system/${this.config.name}.service`);
      case 'darwin':
        return existsSync(`/Library/LaunchDaemons/${this.config.name}.plist`);
      case 'win32':
        try {
          execFileSync('sc', ['query', this.config.name], { stdio: 'pipe', timeout: 5000 });
          return true;
        } catch {
          return false;
        }
    }
  }

  private installSystemd(): ServiceInstallResult {
    const unitPath = `/etc/systemd/system/${this.config.name}.service`;
    const unit = `[Unit]
Description=${this.config.description}
After=network.target

[Service]
Type=simple
ExecStart=${this.config.execPath}
WorkingDirectory=${this.config.workingDir}
${this.config.user ? `User=${this.config.user}` : 'User=root'}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

    try {
      writeFileSync(unitPath, unit, { mode: 0o644 });
      execFileSync('systemctl', ['daemon-reload'], { stdio: 'pipe', timeout: 10000 });
      execFileSync('systemctl', ['enable', this.config.name], { stdio: 'pipe', timeout: 10000 });
      return { state: 'installed', message: `Systemd service installed at ${unitPath}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { state: 'error', message: `Failed to install systemd service: ${msg}` };
    }
  }

  private uninstallSystemd(): ServiceInstallResult {
    const unitPath = `/etc/systemd/system/${this.config.name}.service`;

    try {
      if (existsSync(unitPath)) {
        execFileSync('systemctl', ['stop', this.config.name], { stdio: 'pipe', timeout: 10000 });
        execFileSync('systemctl', ['disable', this.config.name], { stdio: 'pipe', timeout: 10000 });
        unlinkSync(unitPath);
        execFileSync('systemctl', ['daemon-reload'], { stdio: 'pipe', timeout: 10000 });
      }
      return { state: 'not-installed', message: 'Systemd service removed' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { state: 'error', message: `Failed to uninstall systemd service: ${msg}` };
    }
  }

  private installLaunchd(): ServiceInstallResult {
    const plistPath = `/Library/LaunchDaemons/${this.config.name}.plist`;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${this.config.name}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${this.config.execPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${this.config.workingDir}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;

    try {
      writeFileSync(plistPath, plist, { mode: 0o644 });
      execFileSync('launchctl', ['load', plistPath], { stdio: 'pipe', timeout: 10000 });
      return { state: 'installed', message: `Launchd service installed at ${plistPath}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { state: 'error', message: `Failed to install launchd service: ${msg}` };
    }
  }

  private uninstallLaunchd(): ServiceInstallResult {
    const plistPath = `/Library/LaunchDaemons/${this.config.name}.plist`;

    try {
      if (existsSync(plistPath)) {
        execFileSync('launchctl', ['unload', plistPath], { stdio: 'pipe', timeout: 10000 });
        unlinkSync(plistPath);
      }
      return { state: 'not-installed', message: 'Launchd service removed' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { state: 'error', message: `Failed to uninstall launchd service: ${msg}` };
    }
  }

  private installWindows(): ServiceInstallResult {
    try {
      execFileSync('sc', [
        'create', this.config.name,
        'binPath=', this.config.execPath,
        'DisplayName=', this.config.displayName,
        'start=', 'auto',
      ], { stdio: 'pipe', timeout: 10000 });
      execFileSync('sc', ['description', this.config.name, this.config.description], {
        stdio: 'pipe', timeout: 10000,
      });
      return { state: 'installed', message: `Windows service "${this.config.name}" installed` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { state: 'error', message: `Failed to install Windows service: ${msg}` };
    }
  }

  private uninstallWindows(): ServiceInstallResult {
    try {
      execFileSync('sc', ['stop', this.config.name], { stdio: 'pipe', timeout: 10000 });
    } catch {
      // service may not be running
    }
    try {
      execFileSync('sc', ['delete', this.config.name], { stdio: 'pipe', timeout: 10000 });
      return { state: 'not-installed', message: 'Windows service removed' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { state: 'error', message: `Failed to uninstall Windows service: ${msg}` };
    }
  }
}
