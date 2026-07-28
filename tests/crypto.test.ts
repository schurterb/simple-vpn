import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  signWithDomainTag,
  verifyWithDomainTag,
  sha256,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  deriveEd25519Public,
  deriveX25519Public,
  RAW_KEY_LENGTH,
  toBase64url,
  fromBase64url,
  DOMAIN_TAGS,
} from '../src/crypto.js';

describe('crypto', () => {
  describe('Ed25519 sign/verify with domain tag', () => {
    it('verifies a valid signature', () => {
      const { privateKey, publicKey } = generateEd25519KeyPair();
      const data = Buffer.from('test message');
      const sig = signWithDomainTag(data, privateKey, DOMAIN_TAGS.invite);
      assert.equal(verifyWithDomainTag(data, sig, publicKey, DOMAIN_TAGS.invite), true);
    });

    it('rejects wrong domain tag', () => {
      const { privateKey, publicKey } = generateEd25519KeyPair();
      const data = Buffer.from('test message');
      const sig = signWithDomainTag(data, privateKey, DOMAIN_TAGS.invite);
      assert.equal(verifyWithDomainTag(data, sig, publicKey, DOMAIN_TAGS.reply), false);
    });

    it('rejects wrong key', () => {
      const { privateKey } = generateEd25519KeyPair();
      const { publicKey: otherPub } = generateEd25519KeyPair();
      const data = Buffer.from('test message');
      const sig = signWithDomainTag(data, privateKey, DOMAIN_TAGS.invite);
      assert.equal(verifyWithDomainTag(data, sig, otherPub, DOMAIN_TAGS.invite), false);
    });

    it('rejects tampered data', () => {
      const { privateKey, publicKey } = generateEd25519KeyPair();
      const data = Buffer.from('test message');
      const sig = signWithDomainTag(data, privateKey, DOMAIN_TAGS.invite);
      const tampered = Buffer.from('test messagE');
      assert.equal(verifyWithDomainTag(tampered, sig, publicKey, DOMAIN_TAGS.invite), false);
    });
  });

  describe('sha256', () => {
    it('produces 32-byte hash', () => {
      const hash = sha256('test');
      assert.equal(hash.length, 32);
    });

    it('is deterministic', () => {
      assert.deepEqual(sha256('test'), sha256('test'));
    });

    it('differs for different inputs', () => {
      assert.notDeepEqual(sha256('test1'), sha256('test2'));
    });
  });

  describe('base64url', () => {
    it('round-trips', () => {
      const buf = Buffer.from([0, 1, 2, 255, 254]);
      const encoded = toBase64url(buf);
      const decoded = fromBase64url(encoded);
      assert.deepEqual(decoded, buf);
    });

    it('has no padding', () => {
      const buf = Buffer.from([0]); // produces padding in standard base64
      const encoded = toBase64url(buf);
      assert.ok(!encoded.includes('='));
    });
  });

  describe('generateEd25519KeyPair', () => {
    it('produces different keys each call', () => {
      const k1 = generateEd25519KeyPair();
      const k2 = generateEd25519KeyPair();
      assert.notDeepEqual(k1.privateKey, k2.privateKey);
      assert.notDeepEqual(k1.publicKey, k2.publicKey);
    });

    it('produces usable key pairs', () => {
      const { privateKey, publicKey } = generateEd25519KeyPair();
      const data = Buffer.from('hello');
      const sig = signWithDomainTag(data, privateKey, DOMAIN_TAGS.roster);
      assert.equal(verifyWithDomainTag(data, sig, publicKey, DOMAIN_TAGS.roster), true);
    });

    it('produces raw 32-byte keys', () => {
      const { privateKey, publicKey } = generateEd25519KeyPair();
      assert.equal(privateKey.length, RAW_KEY_LENGTH);
      assert.equal(publicKey.length, RAW_KEY_LENGTH);
    });
  });

  describe('generateX25519KeyPair', () => {
    it('produces raw 32-byte keys', () => {
      const { privateKey, publicKey } = generateX25519KeyPair();
      assert.equal(privateKey.length, RAW_KEY_LENGTH);
      assert.equal(publicKey.length, RAW_KEY_LENGTH);
    });
  });

  describe('derive public keys', () => {
    it('deriveEd25519Public matches generated pubkey', () => {
      const { privateKey, publicKey } = generateEd25519KeyPair();
      assert.deepEqual(deriveEd25519Public(privateKey), publicKey);
    });

    it('deriveX25519Public matches generated pubkey', () => {
      const { privateKey, publicKey } = generateX25519KeyPair();
      assert.deepEqual(deriveX25519Public(privateKey), publicKey);
    });
  });
});
