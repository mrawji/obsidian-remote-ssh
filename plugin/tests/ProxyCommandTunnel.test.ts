import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
// #430: a ProxyCommand subprocess transport. None of this exists yet —
// the module import fails today, which is the point: these cases lock
// in the contract the fix must satisfy.
//   ProxyCommand cloudflared access ssh --hostname %h
// OpenSSH spawns that command and uses its stdio as the connection
// stream; ssh2 accepts the same via its `sock` option. The tunnel must
// (a) expand the %-tokens, (b) spawn the command, and (c) bridge the
// child's stdio as a single Duplex stream.
import {
  createProxyCommandTunnel,
  expandProxyCommandTokens,
} from '../src/ssh/ProxyCommandTunnel';

/**
 * Minimal fake of a Node ChildProcess. `stdin`/`stdout` are real
 * PassThrough streams so the tunnel's piping is exercised for real;
 * `kill` records teardown.
 */
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = 0;
  kill(): boolean { this.killed++; return true; }
}

function fakeSpawn() {
  const calls: Array<{ command: string; options: Record<string, unknown> }> = [];
  const child = new FakeChild();
  const spawnFn = ((command: string, options: Record<string, unknown>) => {
    calls.push({ command, options });
    return child;
  }) as unknown as typeof import('child_process').spawn;
  return { spawnFn, calls, child };
}

describe('a proxy that goes away', () => {
  /**
   * Found by running the E2E suite over the tailnet, where every byte
   * leaves through a `ProxyCommand`: the server was stopped and the plugin
   * said nothing at all for 90 seconds — no "connection closed", no
   * reconnect loop. It believed the session was still up.
   *
   * ssh2 subscribes to both `end` and `close` on the socket it is given,
   * but only the latter makes its `Client` emit `close` — and `close` is
   * the single event `SftpClient` reconnects on. A real `net.Socket` emits
   * both, because it destroys itself once the peer is gone. This Duplex is
   * hand-made, so unless it does the same, a dead proxy is indistinguishable
   * from a healthy idle one.
   *
   * Not tailnet-specific: it is every `ProxyCommand` user — cloudflared, a
   * jump host, `tailscale nc` — silently losing reconnect.
   */
  it('closes the stream, not merely ends it, so ssh2 reports a disconnect', async () => {
    const { spawnFn, child } = fakeSpawn();
    const duplex = createProxyCommandTunnel('proxy %h', { host: 'h', port: 22 }, { spawnFn });

    // ssh2 resumes the socket and reads from it; without a reader the
    // readable side never drains and `end` would not fire either.
    duplex.resume();

    const closed = new Promise<void>((resolve) => duplex.once('close', resolve));
    const ended = new Promise<void>((resolve) => duplex.once('end', resolve));

    // The proxy exits — because the remote hung up, or it was killed.
    child.stdout.end();
    child.emit('close', 0);

    await expect(Promise.race([
      Promise.all([ended, closed]).then(() => 'closed'),
      new Promise((r) => setTimeout(() => r('still open'), 1000)),
    ])).resolves.toBe('closed');
  });

  it('reports a proxy that failed as an error, not as a clean end', async () => {
    const { spawnFn, child } = fakeSpawn();
    const duplex = createProxyCommandTunnel('proxy %h', { host: 'h', port: 22 }, { spawnFn });
    duplex.resume();

    const seen = new Promise<Error | null>((resolve) => {
      duplex.once('error', (e: Error) => resolve(e));
      duplex.once('close', () => resolve(null));
    });

    // A non-zero exit is the proxy telling us why it could not carry the
    // connection — `socks5-connect.mjs` exits 1 and explains itself on
    // stderr. Swallowing that leaves ssh2 with "connection lost" and the
    // reason nowhere.
    child.stdout.end();
    child.emit('close', 1);

    const err = await seen;
    expect(err, 'a failed proxy must surface as an error on the stream').toBeInstanceOf(Error);
    expect(String(err?.message)).toMatch(/proxy|exit/i);
  });
});

describe('expandProxyCommandTokens (#430)', () => {
  it('substitutes %h (host) and %p (port)', () => {
    expect(
      expandProxyCommandTokens('ssh -W %h:%p jump.example.com', { host: 'target.example.com', port: 2222 }),
    ).toBe('ssh -W target.example.com:2222 jump.example.com');
  });

  it('substitutes %r (remote user) when provided', () => {
    expect(
      expandProxyCommandTokens('connect --user %r %h', { host: 'h', port: 22, user: 'alice' }),
    ).toBe('connect --user alice h');
  });

  it('expands the real-world cloudflared template', () => {
    expect(
      expandProxyCommandTokens('cloudflared access ssh --hostname %h', { host: 'lab.example.com', port: 22 }),
    ).toBe('cloudflared access ssh --hostname lab.example.com');
  });

  it('unescapes %% to a literal % and does not treat it as a token', () => {
    expect(
      expandProxyCommandTokens('echo 100%% done %h', { host: 'h', port: 22 }),
    ).toBe('echo 100% done h');
  });
});

describe('createProxyCommandTunnel (#430)', () => {
  it('spawns the token-expanded command and returns a stream', () => {
    const { spawnFn, calls } = fakeSpawn();
    const stream = createProxyCommandTunnel(
      'cloudflared access ssh --hostname %h',
      { host: 'lab.example.com', port: 22 },
      { spawnFn },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toContain('cloudflared access ssh --hostname lab.example.com');
    expect(typeof (stream as { pipe?: unknown }).pipe).toBe('function'); // a stream
  });

  it('forwards bytes written to the tunnel into the child stdin (client → proxy)', async () => {
    const { spawnFn, child } = fakeSpawn();
    const stream = createProxyCommandTunnel('proxy %h %p', { host: 'h', port: 22 }, { spawnFn });

    const seen: Buffer[] = [];
    child.stdin.on('data', (c: Buffer) => seen.push(Buffer.from(c)));
    (stream as NodeJS.WritableStream).write(Buffer.from('SSH-2.0-hello'));
    await new Promise((r) => setImmediate(r));

    expect(Buffer.concat(seen).toString()).toBe('SSH-2.0-hello');
  });

  it('surfaces child stdout as readable data on the tunnel (proxy → client)', async () => {
    const { spawnFn, child } = fakeSpawn();
    const stream = createProxyCommandTunnel('proxy %h %p', { host: 'h', port: 22 }, { spawnFn });

    const seen: Buffer[] = [];
    (stream as NodeJS.ReadableStream).on('data', (c: Buffer) => seen.push(Buffer.from(c)));
    child.stdout.write(Buffer.from('SSH-2.0-server'));
    await new Promise((r) => setImmediate(r));

    expect(Buffer.concat(seen).toString()).toBe('SSH-2.0-server');
  });

  it('tears the child process down when the tunnel stream closes', async () => {
    const { spawnFn, child } = fakeSpawn();
    const stream = createProxyCommandTunnel('proxy %h %p', { host: 'h', port: 22 }, { spawnFn });
    expect(child.killed).toBe(0);
    (stream as EventEmitter).emit('close');
    await new Promise((r) => setImmediate(r));
    expect(child.killed).toBe(1);
  });

  it('emits an error on the tunnel when the proxy command cannot be spawned', async () => {
    const child = new FakeChild();
    const spawnFn = (() => child) as unknown as typeof import('child_process').spawn;
    const stream = createProxyCommandTunnel('does-not-exist %h', { host: 'h', port: 22 }, { spawnFn });

    const onError = vi.fn();
    (stream as EventEmitter).on('error', onError);
    child.emit('error', new Error('spawn ENOENT'));
    await new Promise((r) => setImmediate(r));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/ENOENT/) }));
  });
});
