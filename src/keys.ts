import {
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import {
  generateEd25519KeyPair,
  generateX25519KeyPair,
  deriveEd25519Public,
  deriveX25519Public,
  RAW_KEY_LENGTH,
} from './crypto.js';

export interface KeyMaterial {
  privateKey: Buffer;
  publicKey: Buffer;
}

export interface KeyFiles {
  wg: KeyMaterial;
  identity: KeyMaterial;
}

export class KeyManager {
  constructor(
    private readonly wgKeyPath: string,
    private readonly identityKeyPath: string,
  ) {}

  generateWgKeyPair(): KeyMaterial {
    return generateX25519KeyPair();
  }

  generateIdentityKeyPair(): KeyMaterial {
    return generateEd25519KeyPair();
  }

  writeKeyExclusively(path: string, data: Buffer): void {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, data);
    } finally {
      closeSync(fd);
    }
  }

  generateAndStoreKeys(): KeyFiles {
    const wg = this.generateWgKeyPair();
    const identity = this.generateIdentityKeyPair();

    this.writeKeyExclusively(this.wgKeyPath, wg.privateKey);
    this.writeKeyExclusively(this.identityKeyPath, identity.privateKey);

    return { wg, identity };
  }

  loadKey(path: string): Buffer {
    return readFileSync(path);
  }

  loadKeys(): KeyFiles {
    if (!existsSync(this.wgKeyPath)) {
      throw new KeyMissingError(
        'wg.key',
        this.wgKeyPath,
        'WireGuard private key file is missing. If this is a new installation, keys will be generated on first run. If keys were previously generated, restore from backup or re-install.',
      );
    }
    if (!existsSync(this.identityKeyPath)) {
      throw new KeyMissingError(
        'identity.key',
        this.identityKeyPath,
        'Identity private key file is missing. If this is a new installation, keys will be generated on first run. If keys were previously generated, restore from backup or re-install.',
      );
    }

    const wgPrivate = this.loadKey(this.wgKeyPath);
    const identityPrivate = this.loadKey(this.identityKeyPath);

    if (wgPrivate.length === 0) {
      throw new KeyCorruptError('wg.key', this.wgKeyPath, 'WireGuard key file is empty.');
    }
    if (identityPrivate.length === 0) {
      throw new KeyCorruptError('identity.key', this.identityKeyPath, 'Identity key file is empty.');
    }
    if (wgPrivate.length !== RAW_KEY_LENGTH) {
      throw new KeyCorruptError('wg.key', this.wgKeyPath, `WireGuard key must be ${RAW_KEY_LENGTH} raw bytes, got ${wgPrivate.length}.`);
    }
    if (identityPrivate.length !== RAW_KEY_LENGTH) {
      throw new KeyCorruptError('identity.key', this.identityKeyPath, `Identity key must be ${RAW_KEY_LENGTH} raw bytes, got ${identityPrivate.length}.`);
    }

    return {
      wg: { privateKey: wgPrivate, publicKey: deriveX25519Public(wgPrivate) },
      identity: { privateKey: identityPrivate, publicKey: deriveEd25519Public(identityPrivate) },
    };
  }

  keysExist(): boolean {
    return existsSync(this.wgKeyPath) && existsSync(this.identityKeyPath);
  }

  verifyKeyPermissions(): boolean {
    try {
      const wgStat = statSync(this.wgKeyPath);
      const idStat = statSync(this.identityKeyPath);
      return (wgStat.mode & 0o077) === 0 && (idStat.mode & 0o077) === 0;
    } catch {
      return false;
    }
  }
}

export class KeyMissingError extends Error {
  constructor(
    public readonly keyName: string,
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'KeyMissingError';
  }
}

export class KeyCorruptError extends Error {
  constructor(
    public readonly keyName: string,
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'KeyCorruptError';
  }
}
