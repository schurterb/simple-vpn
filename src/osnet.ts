import { execFileSync } from 'node:child_process';
import type { SupportedPlatform } from './platform.js';

export interface OsNetOptions {
  platform: SupportedPlatform;
}

export interface AddressRouteResult {
  success: boolean;
  output: string;
  error: string;
}

export class OsNet {
  constructor(private readonly opts: OsNetOptions) {}

  assignAddress(iface: string, ipWithPrefix: string): AddressRouteResult {
    switch (this.opts.platform) {
      case 'linux':
        return this.run('ip', ['addr', 'add', ipWithPrefix, 'dev', iface]);
      case 'darwin':
        return this.run('ifconfig', [iface, 'inet', ipWithPrefix]);
      case 'win32':
        return this.run('netsh', ['interface', 'ipv4', 'set', 'address', iface, 'static', ipWithPrefix]);
    }
  }

  removeAddress(iface: string, ipWithPrefix: string): AddressRouteResult {
    switch (this.opts.platform) {
      case 'linux':
        return this.run('ip', ['addr', 'del', ipWithPrefix, 'dev', iface]);
      case 'darwin':
        return this.run('ifconfig', [iface, 'inet', ipWithPrefix, 'remove']);
      case 'win32':
        return this.run('netsh', ['interface', 'ipv4', 'delete', 'address', iface, ipWithPrefix]);
    }
  }

  linkUp(iface: string): AddressRouteResult {
    switch (this.opts.platform) {
      case 'linux':
        return this.run('ip', ['link', 'set', 'up', 'dev', iface]);
      case 'darwin':
        return this.run('ifconfig', [iface, 'up']);
      case 'win32':
        return { success: true, output: '', error: '' };
    }
  }

  linkDown(iface: string): AddressRouteResult {
    switch (this.opts.platform) {
      case 'linux':
        return this.run('ip', ['link', 'set', 'down', 'dev', iface]);
      case 'darwin':
        return this.run('ifconfig', [iface, 'down']);
      case 'win32':
        return { success: true, output: '', error: '' };
    }
  }

  addRoute(dest: string, iface: string): AddressRouteResult {
    switch (this.opts.platform) {
      case 'linux':
        return this.run('ip', ['route', 'add', dest, 'dev', iface]);
      case 'darwin':
        return this.run('route', ['-n', 'add', '-net', dest, '-interface', iface]);
      case 'win32':
        return this.run('route', ['add', dest, 'mask', '255.255.255.0', '0.0.0.0', 'IF', iface]);
    }
  }

  removeRoute(dest: string, iface: string): AddressRouteResult {
    switch (this.opts.platform) {
      case 'linux':
        return this.run('ip', ['route', 'del', dest, 'dev', iface]);
      case 'darwin':
        return this.run('route', ['-n', 'delete', '-net', dest, '-interface', iface]);
      case 'win32':
        return this.run('route', ['delete', dest]);
    }
  }

  setMTU(iface: string, mtu: number): AddressRouteResult {
    switch (this.opts.platform) {
      case 'linux':
        return this.run('ip', ['link', 'set', 'mtu', String(mtu), 'dev', iface]);
      case 'darwin':
        return this.run('ifconfig', [iface, 'mtu', String(mtu)]);
      case 'win32':
        return this.run('netsh', ['interface', 'ipv4', 'set', 'subinterface', iface, `mtu=${mtu}`]);
    }
  }

  interfaceExists(iface: string): boolean {
    try {
      switch (this.opts.platform) {
        case 'linux':
          execFileSync('ip', ['link', 'show', 'dev', iface], { stdio: 'pipe' });
          return true;
        case 'darwin':
          execFileSync('ifconfig', [iface], { stdio: 'pipe' });
          return true;
        case 'win32':
          execFileSync('netsh', ['interface', 'show', 'interface', iface], { stdio: 'pipe' });
          return true;
      }
    } catch {
      return false;
    }
  }

  private run(cmd: string, args: string[]): AddressRouteResult {
    try {
      const output = execFileSync(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 10000,
      });
      return { success: true, output, error: '' };
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      return {
        success: false,
        output: '',
        error: e.stderr ?? e.message,
      };
    }
  }
}
