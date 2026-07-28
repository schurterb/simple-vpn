import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeUAPISet, parseUAPIGet, type WgInterfaceConfig } from '../src/wg-uapi.js';

const FAKE_PRIVKEY_B64URL = Buffer.alloc(32, 0xab).toString('base64url');
const FAKE_PUBKEY_B64URL = Buffer.alloc(32, 0xcd).toString('base64url');
const FAKE_PUBKEY2_B64URL = Buffer.alloc(32, 0xef).toString('base64url');

describe('wg-uapi', () => {
  describe('encodeUAPISet', () => {
    it('encodes private key and listen port', () => {
      const config: WgInterfaceConfig = {
        privateKey: FAKE_PRIVKEY_B64URL,
        listenPort: 51820,
        peers: [],
      };
      const result = encodeUAPISet(config);
      assert.ok(result.includes('private_key='));
      assert.ok(result.includes('listen_port=51820'));
    });

    it('encodes peer with endpoint and allowed IPs', () => {
      const config: WgInterfaceConfig = {
        privateKey: FAKE_PRIVKEY_B64URL,
        peers: [
          {
            publicKey: FAKE_PUBKEY_B64URL,
            endpoint: '1.2.3.4:51820',
            allowedIPs: ['10.42.0.2/32'],
            persistentKeepaliveInterval: 25,
          },
        ],
      };
      const result = encodeUAPISet(config);
      assert.ok(result.includes('public_key='));
      assert.ok(result.includes('endpoint=1.2.3.4:51820'));
      assert.ok(result.includes('allowed_ip=10.42.0.2/32'));
      assert.ok(result.includes('persistent_keepalive_interval=25'));
    });

    it('encodes multiple peers', () => {
      const config: WgInterfaceConfig = {
        privateKey: FAKE_PRIVKEY_B64URL,
        peers: [
          {
            publicKey: FAKE_PUBKEY_B64URL,
            allowedIPs: ['10.42.0.2/32'],
          },
          {
            publicKey: FAKE_PUBKEY2_B64URL,
            allowedIPs: ['10.42.0.3/32'],
          },
        ],
      };
      const result = encodeUAPISet(config);
      const peerCount = (result.match(/public_key=/g) ?? []).length;
      assert.equal(peerCount, 2);
    });

    it('omits listen_port when not set', () => {
      const config: WgInterfaceConfig = {
        privateKey: FAKE_PRIVKEY_B64URL,
        peers: [],
      };
      const result = encodeUAPISet(config);
      assert.ok(!result.includes('listen_port'));
    });

    it('omits endpoint when not set', () => {
      const config: WgInterfaceConfig = {
        privateKey: FAKE_PRIVKEY_B64URL,
        peers: [
          {
            publicKey: FAKE_PUBKEY_B64URL,
            allowedIPs: ['10.42.0.2/32'],
          },
        ],
      };
      const result = encodeUAPISet(config);
      assert.ok(!result.includes('endpoint='));
    });

    it('encodes private key as hex', () => {
      const config: WgInterfaceConfig = {
        privateKey: FAKE_PRIVKEY_B64URL,
        peers: [],
      };
      const result = encodeUAPISet(config);
      const expectedHex = Buffer.alloc(32, 0xab).toString('hex');
      assert.ok(result.includes(`private_key=${expectedHex}`));
    });
  });

  describe('parseUAPIGet', () => {
    it('parses interface with no peers', () => {
      const data = 'private_key=ab\nlisten_port=51820\n\n';
      const status = parseUAPIGet(data);
      assert.equal(status.listenPort, 51820);
      assert.equal(status.peers.length, 0);
    });

    it('parses peer with handshake and counters', () => {
      const data = [
        'private_key=ab',
        'listen_port=51820',
        'public_key=cd',
        'endpoint=1.2.3.4:51820',
        'allowed_ip=10.42.0.2/32',
        'last_handshake_time_sec=1000',
        'rx_bytes=12345',
        'tx_bytes=67890',
        'persistent_keepalive_interval=25',
        '',
      ].join('\n');
      const status = parseUAPIGet(data);
      assert.equal(status.peers.length, 1);
      const peer = status.peers[0]!;
      assert.equal(peer.endpoint, '1.2.3.4:51820');
      assert.equal(peer.lastHandshakeTimeSec, 1000);
      assert.equal(peer.rxBytes, 12345);
      assert.equal(peer.txBytes, 67890);
      assert.equal(peer.persistentKeepaliveInterval, 25);
      assert.deepEqual(peer.allowedIPs, ['10.42.0.2/32']);
    });

    it('parses multiple peers', () => {
      const data = [
        'private_key=ab',
        'listen_port=51820',
        'public_key=cd',
        'allowed_ip=10.42.0.2/32',
        'rx_bytes=100',
        'tx_bytes=200',
        'last_handshake_time_sec=0',
        'persistent_keepalive_interval=0',
        'public_key=ef',
        'allowed_ip=10.42.0.3/32',
        'rx_bytes=300',
        'tx_bytes=400',
        'last_handshake_time_sec=0',
        'persistent_keepalive_interval=0',
        '',
      ].join('\n');
      const status = parseUAPIGet(data);
      assert.equal(status.peers.length, 2);
      assert.equal(status.peers[0]!.rxBytes, 100);
      assert.equal(status.peers[1]!.rxBytes, 300);
    });
  });
});
