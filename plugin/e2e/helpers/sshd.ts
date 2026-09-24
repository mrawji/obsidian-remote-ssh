import * as net from 'node:net';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import {
  TEST_HOST, TEST_PORT, TEST_PROXY_COMMAND, START_COMMAND, describeTarget,
} from '../../test-env/target';

/**
 * Test-sshd reachability gate, shared by the connect-lifecycle /
 * connect-failure / reconnect specs.
 *
 * These specs HARD-FAIL (never skip) when sshd is down: a broken
 * connect must not pass CI green — that is precisely how 1.0.49
 * shipped broken. Keeping this in one place stops the three specs
 * from drifting apart (they previously each carried a verbatim copy).
 *
 * Which sshd, and how it is reached, comes from `test-env/target.ts`.
 */

export const SSHD_HOST = TEST_HOST;
export const SSHD_PORT = TEST_PORT;

/** One-shot TCP probe — resolves if the port accepts a connection. */
function probeTcp(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const sock = net
      .connect({ host: SSHD_HOST, port: SSHD_PORT })
      .setTimeout(5_000)
      .once('connect', () => { sock.destroy(); resolve(); })
      .once('timeout', () => { sock.destroy(); reject(new Error('timeout')); })
      .once('error', reject);
  });
}

/**
 * The tailnet host publishes no port on this machine, so the probe goes
 * through the same SOCKS5 `ProxyCommand` the specs use and waits for the
 * server to announce itself.
 *
 * A banner rather than a bare CONNECT: the proxy accepts the CONNECT as soon
 * as the peer is routable, which happens well before sshd inside the node is
 * listening. Waiting for `SSH-` is what makes this gate mean "reachable".
 */
function probeTailnet(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // stdin stays an unwritten pipe: `'ignore'` gives the child /dev/null,
    // which reports EOF at once and half-closes the socket before the
    // banner arrives.
    const proxy = spawn(process.execPath, [
      path.resolve(__dirname, '..', '..', 'scripts', 'socks5-connect.mjs'),
      SSHD_HOST, String(SSHD_PORT),
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    let settled = false;
    const finish = (e?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proxy.kill();
      if (e) reject(e); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('timeout')), 8_000);

    proxy.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8');
      if (out.includes('SSH-')) finish();
    });
    proxy.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    proxy.on('error', (e) => finish(e));
    proxy.on('exit', () => finish(
      out.includes('SSH-') ? undefined : new Error(err.trim() || 'proxy exited without a banner'),
    ));
  });
}

// A proxy in the profile is exactly what "not directly reachable from here"
// means, so it is also what decides how to probe — no environment name needed.
const probeSshd = TEST_PROXY_COMMAND ? probeTailnet : probeTcp;

export async function assertSshdReachable(): Promise<void> {
  await probeSshd().catch((e) => {
    throw new Error(
      `test sshd not reachable at ${describeTarget()} ` +
      `(${(e as Error).message}). Run \`${START_COMMAND}\` first. ` +
      `This spec HARD-FAILS instead of skipping — a broken connect ` +
      `must not pass CI green (that is how 1.0.49 shipped broken).`,
    );
  });
}

/**
 * Poll until sshd accepts connections again, or throw after
 * `timeoutMs`. `npm run sshd:start` exits 0 the moment `docker
 * compose up -d` returns — the container's sshd is NOT yet accepting
 * connections at that point. Without this wait the reconnect spec's
 * recovery assertion times out and blames the *plugin* ("reconnect
 * must recover") when the real fault is "the harness never brought
 * sshd back". This makes that failure attributable.
 */
export async function waitForSshdReachable(
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'unknown';
  while (Date.now() < deadline) {
    try {
      await probeSshd();
      return;
    } catch (e) {
      lastErr = (e as Error).message;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  throw new Error(
    `sshd did not become reachable at ${describeTarget()} within ` +
    `${timeoutMs}ms after restart (last: ${lastErr}). This is a HARNESS ` +
    `fault (the environment was restarted but never came back), NOT a ` +
    `plugin reconnect failure — fix the test environment, not the plugin.`,
  );
}
