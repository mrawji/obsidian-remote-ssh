import { describe, it, expect } from 'vitest';
import * as net from 'net';
import { selectTransport, proxyCommandTransport } from '../src/ssh/Transport';
import type { SshProfile } from '../src/types';
import { describeTransportContract, type TransportHarness } from './helpers/transportContract';

/**
 * The contract, against the implementation that broke it.
 *
 * The proxy here is a real subprocess piping real bytes to a real TCP peer,
 * not a fake child. Both bugs this suite exists for lived in the seam
 * between Node's stream semantics and the code's reading of them, and a
 * fake reproduces the code's assumptions rather than the platform's.
 */

/** A far end the test can hang up on, kill, or send from. */
async function tcpPeer(): Promise<{
  port: number;
  sockets: net.Socket[];
  close(): Promise<void>;
}> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((s) => {
    s.on('error', () => { /* a killed peer resets; that is the point */ });
    sockets.push(s);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as net.AddressInfo).port,
    sockets,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * A ProxyCommand that is genuinely a subprocess piping stdio to TCP, and
 * that fails the way a real one does — non-zero, with a reason on stderr —
 * when told to. `socks5-connect.mjs` exits 1 and explains itself when the
 * proxy refuses the CONNECT; this stands in for that.
 *
 * Not `pipe()` in the inbound direction: the sentinel has to be inspected.
 */
const PROXY = [
  'node -e',
  `"const n=require('net'),s=n.connect(Number(process.argv[1]),'127.0.0.1');`
  + `process.stdin.pipe(s);`
  + `s.on('data',d=>{if(String(d).includes('DIE')){console.error('proxy: refused');process.exit(1)}process.stdout.write(d)});`
  + `s.on('end',()=>process.exit(0));`
  + `s.on('error',()=>process.exit(1));"`,
  '%p',
].join(' ');

/** Give the subprocess time to connect before acting on the peer. */
async function awaitConnection(peer: { sockets: net.Socket[] }): Promise<void> {
  for (let i = 0; i < 100 && peer.sockets.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

describeTransportContract('ProxyCommand', async (): Promise<TransportHarness> => {
  const peer = await tcpPeer();
  return {
    transport: proxyCommandTransport(PROXY),
    // `%p` carries the peer's port into the command; this proxy ignores the
    // host, but a target still has to look like one.
    target: { host: 'contract.test', port: peer.port, user: 'tester' },
    async hangUp() {
      await awaitConnection(peer);
      peer.sockets.forEach((s) => s.end());
    },
    async killAbnormally() {
      await awaitConnection(peer);
      // Make the PROXY fail, not the peer: a peer reset reaches the proxy
      // as an ordinary close and it exits 0, which is a clean end and
      // correctly silent. What must be named is the proxy's own failure.
      peer.sockets.forEach((s) => s.write('DIE'));
    },
    async send(bytes: string) {
      await awaitConnection(peer);
      peer.sockets.forEach((s) => s.write(bytes));
      await new Promise((r) => setTimeout(r, 50));
    },
    cleanup: () => peer.close(),
  };
});

describe('selectTransport', () => {
  const base = { host: 'h', port: 22, username: 'u' } as unknown as SshProfile;
  const deps = { authResolver: {}, hostKeyStore: {} } as never;

  it('returns null for a direct connection, so ssh2 owns the socket', () => {
    // Not a DirectTransport: wrapping ssh2's own socket would change TCP
    // options, DNS and timeouts to buy only uniformity.
    expect(selectTransport(base, deps)).toBeNull();
  });

  it('picks the ProxyCommand when the profile names one', () => {
    expect(selectTransport({ ...base, proxyCommand: 'nc %h %p' }, deps)?.name)
      .toBe('ProxyCommand');
  });

  it('picks the bastion when the profile names one', () => {
    const t = selectTransport(
      { ...base, jumpHost: { host: 'bastion', port: 22, username: 'u' } } as SshProfile,
      deps,
    );
    expect(t?.name).toContain('bastion');
  });

  it('prefers the bastion when a profile somehow names both', () => {
    // The more specific route, and the one whose host key we verify.
    const t = selectTransport(
      {
        ...base,
        proxyCommand: 'nc %h %p',
        jumpHost: { host: 'bastion', port: 22, username: 'u' },
      } as SshProfile,
      deps,
    );
    expect(t?.name).toContain('bastion');
  });
});
