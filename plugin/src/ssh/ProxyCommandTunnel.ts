import { spawn } from 'child_process';
import { Duplex } from 'stream';
import { logger } from '../util/logger';

/**
 * The concrete connection target a `ProxyCommand`'s %-tokens expand
 * against. `%h` → host, `%p` → port, `%r` → remote user.
 */
export interface ProxyCommandTarget {
  host: string;
  port: number;
  user?: string;
}

export interface ProxyCommandTunnelOptions {
  /** Injection seam for tests; defaults to `child_process.spawn`. */
  spawnFn?: typeof spawn;
}

/**
 * Expand the OpenSSH `ProxyCommand` %-tokens against a concrete target.
 * Supports `%h` (host), `%p` (port), `%r` (remote user) and `%%`
 * (a literal `%`). Unknown `%x` sequences are left untouched.
 */
export function expandProxyCommandTokens(template: string, target: ProxyCommandTarget): string {
  return template.replace(/%[hpr%]/g, (tok) => {
    switch (tok) {
      case '%h': return target.host;
      case '%p': return String(target.port);
      case '%r': return target.user ?? '';
      case '%%': return '%';
      default:   return tok;
    }
  });
}

/**
 * Open a `ProxyCommand` transport: spawn the (token-expanded) command
 * through the platform shell — exactly as OpenSSH runs
 * `/bin/sh -c <ProxyCommand>` — and bridge its stdio as a single
 * `Duplex`. The returned stream is what ssh2 takes as its `sock`
 * option: ssh2 writes the SSH protocol into the child's stdin and
 * reads the peer's bytes from its stdout.
 *
 * Desktop-only: `child_process` is unavailable on mobile. Callers must
 * gate on `Platform.isDesktop` before reaching this path.
 */
export function createProxyCommandTunnel(
  proxyCommand: string,
  target: ProxyCommandTarget,
  opts: ProxyCommandTunnelOptions = {},
): Duplex {
  const spawnFn = opts.spawnFn ?? spawn;
  const command = expandProxyCommandTokens(proxyCommand, target);
  logger.info(`ProxyCommandTunnel: spawning proxy for ${target.host}:${target.port}`);

  // `shell: true` + a full command line mirrors OpenSSH's behaviour
  // (the directive is a command line, not an argv vector). With no
  // `stdio` option this overload returns a ChildProcessWithoutNullStreams
  // so stdin/stdout/stderr are guaranteed non-null.
  const child = spawnFn(command, { shell: true });

  const duplex = new Duplex({
    read() {
      // Resume the child's stdout if backpressure had paused it.
      child.stdout.resume();
    },
    write(chunk: Buffer, _enc, cb) {
      child.stdin.write(chunk, (err) => cb(err ?? undefined));
    },
    final(cb) {
      child.stdin.end();
      cb();
    },
  });

  // proxy → client: push child stdout onto the readable side, honouring
  // backpressure so a slow consumer can't make us buffer without bound.
  child.stdout.on('data', (chunk: Buffer) => {
    if (!duplex.push(chunk)) child.stdout.pause();
  });
  child.stdout.on('end', () => duplex.push(null));

  // Kept so a non-zero exit can say WHY. A proxy writes its one-line reason
  // here before exiting — `socks5-connect.mjs` does — and without carrying
  // it onto the stream, ssh2 reports only "connection lost" and the cause
  // is nowhere.
  let lastStderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    lastStderr = chunk.toString().trim();
    logger.warn(`ProxyCommandTunnel[${target.host}] stderr: ${lastStderr}`);
  });

  // Spawn failure (ENOENT for a missing proxy binary, EACCES, …) surfaces
  // on the stream so ssh2's connect rejects with a clear cause.
  child.on('error', (err: Error) => {
    duplex.destroy(err);
  });
  child.on('close', (code: number | null) => {
    // EOF first, so anything the proxy managed to deliver is still read.
    duplex.push(null);

    if (code && code !== 0) {
      logger.warn(`ProxyCommandTunnel[${target.host}] proxy exited with code ${code}`);
      duplex.destroy(new Error(
        `ProxyCommand exited with code ${code}` + (lastStderr ? `: ${lastStderr}` : ''),
      ));
      return;
    }

    // A clean exit still means the connection is over, and the stream has
    // to say so the way a socket does — by reaching `close`, not by
    // stopping at `end`.
    //
    // ssh2 listens for both, but only `close` makes its `Client` emit
    // `close`, and that is the one event `SftpClient` reconnects on. Ending
    // here (rather than destroying) lets the writable side finish and the
    // stream auto-destroy once the reader has drained, so `end` still
    // arrives first and nothing in flight is dropped.
    //
    // Without this, stopping the server behind a ProxyCommand produced no
    // reconnect and no log line at all: the session looked healthy and idle
    // for as long as anyone waited. Found by running the E2E suite over the
    // tailnet, where every byte goes through a proxy — but it was every
    // ProxyCommand user, not just that environment.
    duplex.end();
  });

  // When ssh2 (or the caller) closes the tunnel, reap the proxy process
  // so it can't linger.
  duplex.on('close', () => {
    if (!child.killed) child.kill();
  });

  return duplex;
}
