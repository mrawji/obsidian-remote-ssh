import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';

/**
 * `scripts/socks5-connect.mjs` is the `ProxyCommand` that gets the test suite
 * into the tailnet environment (`docker-compose.tailnet.yml`). It is a
 * hand-rolled SOCKS5 client, and the failures it has to report are the ones
 * nobody else can: when the proxy misbehaves, this process is the only thing
 * that can say so.
 *
 * ## What this pins
 *
 * Two silent failures found in review, both reproduced before being fixed:
 *
 *   - A proxy that accepts the connection and then hangs up sends **no**
 *     `error` event — just a clean FIN. The script used to exit **0** with an
 *     empty stdout and an empty stderr, which `ProxyCommandTunnel` reads as a
 *     tunnel that closed normally (it only warns when the exit code is
 *     non-zero, and `0` is falsy). A broken tailnet was indistinguishable
 *     from a finished one.
 *   - Once a stream has ended, `sock.read(n)` stops returning `null` and
 *     hands back whatever short remainder is buffered. A 2-byte CONNECT
 *     reply was accepted as a 4-byte one and indexed past its end, so the
 *     script reported `unknown address type undefined` — an invented reason
 *     that sends whoever is debugging in the wrong direction.
 *
 * These are asserted against real sockets and a real child process rather
 * than mocks, because both bugs lived precisely in the seam between Node's
 * stream semantics and this script's reading of them — a mock would have
 * reproduced the script's assumptions, not the platform's behaviour.
 */

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'socks5-connect.mjs');

const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** Start a fake proxy on an ephemeral port; `onConn` decides how it misbehaves. */
function fakeProxy(onConn: (sock: net.Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      // Every case here ends with the script exiting while this side is
      // still open. POSIX reports that as EOF; Windows sends an RST, which
      // surfaces as an `error` event — and an unhandled one fails the whole
      // file even though every assertion passed. The reset IS the expected
      // outcome, so it is swallowed rather than asserted on.
      sock.on('error', () => { /* peer went away, which is the point */ });
      onConn(sock);
    });
    server.on('error', () => { /* closed underneath us in afterEach */ });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

interface Run { code: number | null; stdout: string; stderr: string }

/** Run the script against `port` and collect how it ended. */
function runScript(port: number, host = 'example.test'): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, host, '22', `127.0.0.1:${port}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Read the client's greeting, answer "SOCKS5, no auth", then hand over. */
function afterGreeting(sock: net.Socket, then: (sock: net.Socket) => void): void {
  sock.once('data', () => {
    sock.write(Buffer.from([0x05, 0x00]));
    sock.once('data', () => then(sock));
  });
}

describe('socks5-connect as a ProxyCommand', () => {
  it('reports a proxy that hangs up instead of exiting like a finished tunnel', async () => {
    // The whole point: a clean FIN with no reply raises no `error` event, so
    // nothing but this check stands between a dead tailnet and a green run.
    const port = await fakeProxy((sock) => sock.end());
    const r = await runScript(port);

    expect(r.code, 'exiting 0 here reads downstream as "the tunnel closed normally"').toBe(1);
    expect(r.stderr).toContain('closed the connection before the SOCKS5 handshake completed');
    expect(r.stdout).toBe('');
  });

  it('reports a truncated reply as truncated, not as some invented field', async () => {
    const port = await fakeProxy((sock) => afterGreeting(sock, (s) => {
      s.write(Buffer.from([0x05, 0x00]));  // 2 bytes of a 4-byte reply
      s.end();
    }));
    const r = await runScript(port);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain('2 of 4 expected bytes');
    expect(r.stderr, 'the old message blamed the address type for a short read')
      .not.toContain('unknown address type');
  });

  it('reports the proxy\'s own refusal reason', async () => {
    // 0x05 = "connection refused" in RFC 1928's reply table. The reason the
    // proxy gives is the most useful line in a tailnet failure, so losing it
    // would leave only "connection lost before handshake".
    const port = await fakeProxy((sock) => afterGreeting(sock, (s) => {
      s.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      s.end();
    }));
    const r = await runScript(port);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain('connection refused');
  });

  it('refuses a proxy that demands authentication rather than proceeding blind', async () => {
    const port = await fakeProxy((sock) => {
      sock.once('data', () => sock.write(Buffer.from([0x05, 0x02])));  // 0x02 = user/pass
    });
    const r = await runScript(port);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain('demands authentication');
  });

  it('refuses something that is not a SOCKS5 proxy', async () => {
    const port = await fakeProxy((sock) => {
      sock.once('data', () => sock.write(Buffer.from([0x04, 0x00])));  // SOCKS4
    });
    const r = await runScript(port);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not a SOCKS5 proxy');
  });

  it('says so when there is no proxy at all', async () => {
    // An ephemeral port nothing is listening on: the developer forgot
    // `npm run tailnet:start`, which should not look like a plugin fault.
    const port = await fakeProxy(() => { /* never reached */ });
    for (const s of servers.splice(0)) s.close();
    await new Promise((r) => setTimeout(r, 50));

    const r = await runScript(port);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('cannot reach SOCKS5 proxy');
  });

  it('pipes bytes both ways once the handshake succeeds, and exits 0 at EOF', async () => {
    // The happy path, which the failure checks must not have broken: a
    // complete reply, then the peer's bytes must reach stdout verbatim.
    const port = await fakeProxy((sock) => afterGreeting(sock, (s) => {
      s.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));  // granted, IPv4
      s.write('SSH-2.0-FakeServer\r\n');
      s.end();
    }));
    const r = await runScript(port);

    expect(r.stdout, 'the server\'s banner must arrive unmangled').toContain('SSH-2.0-FakeServer');
    expect(r.code, 'a tunnel that ends normally is not a failure').toBe(0);
    expect(r.stderr).toBe('');
  });

  it('sends the hostname unresolved, so MagicDNS names resolve inside the tailnet', async () => {
    // ATYP=3 (domain name), not an address this machine resolved first —
    // `vault.tailnet.test` only means something to `tailscaled`.
    let request: Buffer | undefined;
    const port = await fakeProxy((sock) => {
      sock.once('data', () => {
        sock.write(Buffer.from([0x05, 0x00]));
        sock.once('data', (req: Buffer) => {
          request = req;
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          sock.end();
        });
      });
    });
    await runScript(port, 'vault.tailnet.test');

    expect(request).toBeDefined();
    expect(request![3], 'ATYP must be 3 (domain name)').toBe(0x03);
    const len = request![4];
    expect(request!.subarray(5, 5 + len).toString()).toBe('vault.tailnet.test');
    expect(request!.readUInt16BE(5 + len), 'port 22, big-endian').toBe(22);
  });
});
