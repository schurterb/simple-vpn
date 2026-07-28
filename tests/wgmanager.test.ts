import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseErrno } from '../src/wgmanager.js';

describe('wgmanager parseErrno', () => {
  it('returns 0 on success response', () => {
    assert.equal(parseErrno('errno=0\n\n'), 0);
  });

  it('returns the nonzero errno on failure', () => {
    assert.equal(parseErrno('errno=2\n\n'), 2);
  });

  it('handles negative errno', () => {
    assert.equal(parseErrno('errno=-14\n\n'), -14);
  });

  it('treats a missing errno line as success', () => {
    assert.equal(parseErrno('some=thing\n\n'), 0);
  });

  it('parses errno amid other response lines', () => {
    assert.equal(parseErrno('public_key=abc\nerrno=5\n\n'), 5);
  });
});
