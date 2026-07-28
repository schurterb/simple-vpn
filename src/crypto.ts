import { createHash, sign, verify, generateKeyPairSync, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

export const DOMAIN_TAGS = {
  invite: 'svpn-invite-v1',
  reply: 'svpn-reply-v1',
  roster: 'svpn-roster-v1',
  ctrl: 'svpn-ctrl-v1',
} as const;

export type DomainTag = (typeof DOMAIN_TAGS)[keyof typeof DOMAIN_TAGS];

// DER structure prefixes for raw 32-byte OKP keys (RFC 8410).
// Raw keys are wrapped with these prefixes to build pkcs8/spki DER for node:crypto.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export const RAW_KEY_LENGTH = 32;

function rawPrivateToKeyObject(raw32: Buffer, prefix: Buffer): KeyObject {
  const der = Buffer.concat([prefix, raw32]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function rawPublicToKeyObject(raw32: Buffer, prefix: Buffer): KeyObject {
  const der = Buffer.concat([prefix, raw32]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function extractRaw(der: Buffer): Buffer {
  // The raw 32-byte key is always the final 32 bytes of the OKP DER encoding.
  return der.subarray(der.length - RAW_KEY_LENGTH);
}

export function signWithDomainTag(
  canonicalBytes: Buffer,
  privateKey: Buffer,
  tag: DomainTag,
): Buffer {
  const message = Buffer.concat([
    Buffer.from(tag, 'utf-8'),
    Buffer.from([0x00]),
    canonicalBytes,
  ]);
  const key = rawPrivateToKeyObject(privateKey, ED25519_PKCS8_PREFIX);
  return sign(null, message, key);
}

export function verifyWithDomainTag(
  canonicalBytes: Buffer,
  signature: Buffer,
  publicKey: Buffer,
  tag: DomainTag,
): boolean {
  const message = Buffer.concat([
    Buffer.from(tag, 'utf-8'),
    Buffer.from([0x00]),
    canonicalBytes,
  ]);
  try {
    const key = rawPublicToKeyObject(publicKey, ED25519_SPKI_PREFIX);
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

export function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest();
}

export function generateEd25519KeyPair(): { privateKey: Buffer; publicKey: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: extractRaw(Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' }))),
    publicKey: extractRaw(Buffer.from(publicKey.export({ type: 'spki', format: 'der' }))),
  };
}

export function generateX25519KeyPair(): { privateKey: Buffer; publicKey: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return {
    privateKey: extractRaw(Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' }))),
    publicKey: extractRaw(Buffer.from(publicKey.export({ type: 'spki', format: 'der' }))),
  };
}

export function deriveEd25519Public(privateKeyRaw32: Buffer): Buffer {
  const priv = rawPrivateToKeyObject(privateKeyRaw32, ED25519_PKCS8_PREFIX);
  const pub = createPublicKey(priv);
  return extractRaw(Buffer.from(pub.export({ type: 'spki', format: 'der' })));
}

export function deriveX25519Public(privateKeyRaw32: Buffer): Buffer {
  const priv = rawPrivateToKeyObject(privateKeyRaw32, X25519_PKCS8_PREFIX);
  const pub = createPublicKey(priv);
  return extractRaw(Buffer.from(pub.export({ type: 'spki', format: 'der' })));
}

export function toBase64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function fromBase64url(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}
