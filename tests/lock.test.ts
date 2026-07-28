import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SingleInstanceLock } from '../src/lock.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';

describe('SingleInstanceLock', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'svpn-lock-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires lock successfully', () => {
    const lockFile = join(dir, 'test.lock');
    const lock = new SingleInstanceLock(lockFile);
    assert.equal(lock.acquire(), true);
    assert.equal(lock.isHeld(), true);
    assert.equal(existsSync(lockFile), true);
    lock.release();
    assert.equal(lock.isHeld(), false);
    assert.equal(existsSync(lockFile), false);
  });

  it('fails to acquire when already held', () => {
    const lockFile = join(dir, 'test2.lock');
    const lock1 = new SingleInstanceLock(lockFile);
    const lock2 = new SingleInstanceLock(lockFile);
    assert.equal(lock1.acquire(), true);
    assert.equal(lock2.acquire(), false);
    lock1.release();
  });

  it('release is safe when not held', () => {
    const lockFile = join(dir, 'test3.lock');
    const lock = new SingleInstanceLock(lockFile);
    lock.release();
    assert.equal(lock.isHeld(), false);
  });

  it('can re-acquire after release', () => {
    const lockFile = join(dir, 'test4.lock');
    const lock = new SingleInstanceLock(lockFile);
    assert.equal(lock.acquire(), true);
    lock.release();
    assert.equal(lock.acquire(), true);
    lock.release();
  });

  it('writes PID to lock file on acquire', () => {
    const lockFile = join(dir, 'test5.lock');
    const lock = new SingleInstanceLock(lockFile);
    assert.equal(lock.acquire(), true);
    const content = readFileSync(lockFile, 'utf-8').trim();
    assert.equal(content, String(process.pid));
    lock.release();
  });

  it('readPid returns PID from existing lock file', () => {
    const lockFile = join(dir, 'test6.lock');
    const lock = new SingleInstanceLock(lockFile);
    assert.equal(lock.acquire(), true);
    const pid = SingleInstanceLock.readPid(lockFile);
    assert.equal(pid, process.pid);
    lock.release();
  });

  it('readPid returns null when lock file missing', () => {
    const lockFile = join(dir, 'nonexistent.lock');
    assert.equal(SingleInstanceLock.readPid(lockFile), null);
  });

  it('readPid returns null for invalid content', () => {
    const lockFile = join(dir, 'invalid.lock');
    const { writeFileSync } = require('node:fs');
    writeFileSync(lockFile, 'not-a-pid');
    assert.equal(SingleInstanceLock.readPid(lockFile), null);
  });
});
