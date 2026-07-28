export type SupportedPlatform = 'linux' | 'darwin' | 'win32';
export type SupportedArch = 'x64' | 'arm64';

export interface PlatformInfo {
  os: SupportedPlatform;
  arch: SupportedArch;
  isElevated: boolean;
}

const SUPPORTED_OS: readonly string[] = ['linux', 'darwin', 'win32'];
const SUPPORTED_ARCH: readonly string[] = ['x64', 'arm64'];

export function detectPlatform(
  os: string,
  arch: string,
  isElevated: boolean,
): PlatformInfo {
  if (!SUPPORTED_OS.includes(os)) {
    throw new Error(
      `Unsupported operating system: ${os}. Supported: ${SUPPORTED_OS.join(', ')}`,
    );
  }
  if (!SUPPORTED_ARCH.includes(arch)) {
    throw new Error(
      `Unsupported architecture: ${arch}. Supported: ${SUPPORTED_ARCH.join(', ')}`,
    );
  }
  return {
    os: os as SupportedPlatform,
    arch: arch as SupportedArch,
    isElevated,
  };
}

export function isElevated(): boolean {
  if (process.platform === 'win32') {
    return process.env['USERPROFILE']?.toLowerCase().includes('system32') ?? false;
  }
  return process.getuid?.() === 0;
}

export function getPlatformInfo(): PlatformInfo {
  return detectPlatform(process.platform, process.arch, isElevated());
}
