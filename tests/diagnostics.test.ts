import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseTunnel, diagnoseUdp, EchoResponder, DIAG_NONCE_SIZE } from '../src/diagnostics.js';
import { generateEd25519KeyPair } from '../src/crypto.js';
import type { WgInterfaceStatus } from '../src/wg-uapi.js';

function makeStatus(overrides: Partial<WgInterfaceStatus> = {}): WgInterfaceStatus {
  return {
    publicKey: 'test',
    listenPort: 51820,
    peers: [],
    ...overrides,
  };
}

function makePeer(handshakeAgeSec: number, rx: number = 100, tx: number = 50) {
  const now = Math.floor(Date.now() / 1000);
  return {
    publicKey: 'peer1',
    endpoint: '1.2.3.4:51820',
    allowedIPs: ['10.42.0.2/32'],
    lastHandshakeTimeSec: handshakeAgeSec > 0 ? now - handshakeAgeSec : 0,
    rxBytes: rx,
    txBytes: tx,
    persistentKeepaliveInterval: 25,
  };
}

describe('diagnostics', () => {
  describe('diagnoseTunnel', () => {
    it('returns yellow when no peers', () => {
      const result = diagnoseTunnel(makeStatus());
      assert.equal(result.result, 'yellow');
    });

    it('returns green when all peers have fresh handshakes', () => {
      const status = makeStatus({
        peers: [makePeer(60), makePeer(30)],
      });
      const result = diagnoseTunnel(status);
      assert.equal(result.result, 'green');
    });

    it('returns yellow when some peers stale', () => {
      const status = makeStatus({
        peers: [makePeer(60), makePeer(300)],
      });
      const result = diagnoseTunnel(status);
      assert.equal(result.result, 'yellow');
    });

    it('returns red when no peers have fresh handshakes', () => {
      const status = makeStatus({
        peers: [makePeer(300), makePeer(400)],
      });
      const result = diagnoseTunnel(status);
      assert.equal(result.result, 'red');
    });

    it('returns red when no handshakes at all', () => {
      const status = makeStatus({
        peers: [makePeer(0)],
      });
      const result = diagnoseTunnel(status);
      assert.equal(result.result, 'red');
    });

    it('includes byte counters in detail for green', () => {
      const status = makeStatus({
        peers: [makePeer(60, 12345, 6789)],
      });
      const result = diagnoseTunnel(status);
      assert.ok(result.detail.includes('12345'));
      assert.ok(result.detail.includes('6789'));
    });
  });

  describe('EchoResponder (overlay UDP echo, C2)', () => {
    const serverKeys = generateEd25519KeyPair();
    const clientKeys = generateEd25519KeyPair();
    const port = 42600 + Math.floor(Math.random() * 200);
    let responder: EchoResponder | null = null;

    afterEach(async () => {
      if (responder) await responder.stop();
      responder = null;
    });

    it('uses an 8-byte nonce', () => {
      assert.equal(DIAG_NONCE_SIZE, 8);
    });

    it('completes an authenticated echo for a known peer', async () => {
      responder = new EchoResponder('127.0.0.1', serverKeys.privateKey, [clientKeys.publicKey], port);
      await responder.start();
      const res = await diagnoseUdp('127.0.0.1', port, clientKeys.privateKey, serverKeys.publicKey, 2000);
      assert.equal(res.result, 'green');
    });

    it('does not respond to an unknown peer', async () => {
      responder = new EchoResponder('127.0.0.1', serverKeys.privateKey, [], port);
      await responder.start();
      const res = await diagnoseUdp('127.0.0.1', port, clientKeys.privateKey, serverKeys.publicKey, 500);
      assert.equal(res.result, 'red');
    });
  });
});
