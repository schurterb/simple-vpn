import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeAtomically, writeJsonAtomically, readJsonFile, fileExists } from '../src/atomic-io.js';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('atomic-io', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'svpn-atomic-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('writeAtomically', () => {
    it('writes file content', () => {
      const path = join(dir, 'test.txt');
      writeAtomically(path, 'hello world');
      assert.equal(readFileSync(path, 'utf-8'), 'hello world');
    });

    it('overwrites existing file', () => {
      const path = join(dir, 'test.txt');
      writeAtomically(path, 'first');
      writeAtomically(path, 'second');
      assert.equal(readFileSync(path, 'utf-8'), 'second');
    });

    it('leaves no temp files after success', () => {
      const path = join(dir, 'test.txt');
      writeAtomically(path, 'data');
      const files = readdirSync(dir);
      assert.equal(files.length, 1);
      assert.equal(files[0], 'test.txt');
    });

    it('creates parent directories if needed', () => {
      const path = join(dir, 'subdir', 'test.txt');
      writeAtomically(path, 'nested');
      assert.equal(readFileSync(path, 'utf-8'), 'nested');
    });
  });

  describe('writeJsonAtomically', () => {
    it('writes JSON with formatting', () => {
      const path = join(dir, 'config.json');
      writeJsonAtomically(path, { name: 'test', value: 42 });
      const content = readFileSync(path, 'utf-8');
      assert.deepEqual(JSON.parse(content), { name: 'test', value: 42 });
    });
  });

  describe('readJsonFile', () => {
    it('reads and parses JSON', () => {
      const path = join(dir, 'data.json');
      writeJsonAtomically(path, { foo: 'bar' });
      const result = readJsonFile<{ foo: string }>(path);
      assert.equal(result.foo, 'bar');
    });

    it('throws on invalid JSON', () => {
      const path = join(dir, 'bad.json');
      writeFileSync(path, '{ not valid json');
      assert.throws(() => readJsonFile(path), SyntaxError);
    });
  });

  describe('fileExists', () => {
    it('returns false for non-existent file', () => {
      assert.equal(fileExists(join(dir, 'nope.txt')), false);
    });

    it('returns true for existing file', () => {
      const path = join(dir, 'exists.txt');
      writeFileSync(path, 'data');
      assert.equal(fileExists(path), true);
    });
  });
});
