#!/usr/bin/env node
/**
 * A `ProxyCommand` that reaches the test tailnet.
 *
 *   node scripts/socks5-connect.mjs <host> <port> [socks-host:socks-port]
 *
 * Performs the SOCKS5 CONNECT against `ts-client`'s published port, then
 * pipes stdin/stdout — the contract OpenSSH's `ProxyCommand`, and so
 * `ProxyCommandTunnel`, expects.
 *
 * Not `nc -X 5`: that flag is a BSD/openbsd-netcat extension, absent from
 * GNU netcat, busybox and Windows.
 *
 * The hostname goes to the proxy unresolved (ATYP=3) so `tailscaled`
 * resolves MagicDNS names, as a real user's resolver would.
 */

import * as net from 'node:net';

const [host, portArg, proxyArg] = process.argv.slice(2);
const port = Number(portArg);

if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('usage: socks5-connect.mjs <host> <port> [socks-host:socks-port]');
  process.exit(2);
}

const [proxyHost, proxyPortArg] = (proxyArg ?? process.env.ORSSH_SOCKS5 ?? '127.0.0.1:1055').split(':');
const proxyPort = Number(proxyPortArg);

/**
 * Both halves matter: `ProxyCommandTunnel` logs this stderr and warns on a
 * non-zero exit, and exiting 0 after a failed handshake is indistinguishable
 * from a tunnel that closed normally.
 */
function die(msg) {
  console.error(`socks5-connect: ${msg}`);
  process.exit(1);
}

/** Until this is set, a closed socket is a failure, not an end-of-tunnel. */
let piping = false;

/** How far the handshake got, for the diagnostics in `read()`. */
let bytesRead = 0;

const sock = net.connect(proxyPort, proxyHost);
sock.on('error', (e) => die(`cannot reach SOCKS5 proxy at ${proxyHost}:${proxyPort}: ${e.message}`));

/**
 * Read exactly `n` bytes of the SOCKS5 handshake.
 *
 * The socket is left in paused mode throughout — `sock.read(n)` takes only
 * what the handshake needs and anything the peer sent after it stays in the
 * stream's own buffer, so the `pipe()` below picks it up intact. Draining
 * the socket with a `data` handler instead loses that race: the SSH banner
 * can arrive in the same TCP segment as the SOCKS5 reply, and pushing the
 * remainder back by hand corrupts the very first bytes ssh2 reads.
 */
function read(n) {
  return new Promise((resolve) => {
    const attempt = () => {
      const chunk = sock.read(n);
      // After the stream ends, `read(n)` returns a SHORT buffer rather than
      // null. Accepting it indexes past the reply and invents a reason.
      if (chunk && chunk.length === n) resolve(chunk);
      else if (chunk) die(`proxy sent ${chunk.length} of ${n} expected bytes, then closed`);
      else if (sock.readableEnded) die(`proxy closed the connection after ${bytesRead} bytes, mid-handshake`);
      else sock.once('readable', attempt);
    };
    attempt();
  }).then((chunk) => { bytesRead += chunk.length; return chunk; });
}

const SOCKS5_REPLY = {
  1: 'general failure',
  2: 'connection not allowed',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
};

sock.on('connect', async () => {
  // Greeting: SOCKS5, one method, "no authentication".
  sock.write(Buffer.from([0x05, 0x01, 0x00]));
  const greeting = await read(2);
  if (greeting[0] !== 0x05) die(`not a SOCKS5 proxy (version byte ${greeting[0]})`);
  if (greeting[1] !== 0x00) die(`proxy demands authentication (method ${greeting[1]})`);

  // CONNECT to a domain name — see the note about MagicDNS above.
  const name = Buffer.from(host, 'utf8');
  if (name.length > 255) die(`hostname too long for SOCKS5: ${name.length} bytes`);
  const request = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
    name,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]);
  sock.write(request);

  const reply = await read(4);
  if (reply[1] !== 0x00) {
    die(`proxy refused CONNECT to ${host}:${port} — ${SOCKS5_REPLY[reply[1]] ?? `code ${reply[1]}`}`);
  }
  // Consume the bound address the proxy echoes back; its length depends on
  // the address type it chose, which need not match the one we sent.
  const atyp = reply[3];
  if (atyp === 0x01) await read(4 + 2);
  else if (atyp === 0x04) await read(16 + 2);
  else if (atyp === 0x03) { const len = await read(1); await read(len[0] + 2); }
  else die(`proxy replied with unknown address type ${atyp}`);

  piping = true;
  process.stdin.pipe(sock);
  sock.pipe(process.stdout);
});

// A peer that accepts and then hangs up emits no `error` at all, so without
// the guard this exited 0 with empty stdout and said nothing.
sock.on('close', () => {
  if (piping) process.exit(0);
  die('proxy closed the connection before the SOCKS5 handshake completed');
});
process.stdin.on('end', () => sock.end());
