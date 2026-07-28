import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, isElevated, getPlatformInfo } from '../src/platform.js';

describe('platform', () => {
  describe('detectPlatform', () => {
    it('accepts linux/x64', () => {
      const info = detectPlatform('linux', 'x64', false);
      assert.equal(info.os, 'linux');
      assert.equal(info.arch, 'x64');
      assert.equal(info.isElevated, false);
    });

    it('accepts darwin/arm64', () => {
      const info = detectPlatform('darwin', 'arm64', true);
      assert.equal(info.os, 'darwin');
      assert.equal(info.arch, 'arm64');
      assert.equal(info.isElevated, true);
    });

    it('accepts win32/x64', () => {
      const info = detectPlatform('win32', 'x64', false);
      assert.equal(info.os, 'win32');
    });

    it('rejects unsupported OS', () => {
      assert.throws(() => detectPlatform('freebsd', 'x64', false), /Unsupported operating system/);
    });

    it('rejects unsupported arch', () => {
      assert.throws(() => detectPlatform('linux', 'ia32', false), /Unsupported architecture/);
    });
  });

  describe('isElevated', () => {
    it('returns boolean', () => {
      const result = isElevated();
      assert.equal(typeof result, 'boolean');
    });
  });

  describe('getPlatformInfo', () => {
    it('returns current platform info', () => {
      const info = getPlatformInfo();
      assert.equal(info.os, process.platform);
      assert.equal(info.arch, process.arch);
    });
  });
});
