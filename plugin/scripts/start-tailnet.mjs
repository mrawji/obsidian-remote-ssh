#!/usr/bin/env node
/**
 * Bring up the tailnet test environment (`docker-compose.tailnet.yml`).
 *
 * The same sshd image and keypair as `sshd:start`, but published nowhere:
 * the only route to port 22 is a private WireGuard mesh, which this script
 * builds from scratch with a self-hosted headscale control plane. No
 * Tailscale account, no auth key, no login — so it runs in CI unattended.
 *
 * Steps:
 *   - generate `docker/keys/id_test{,.pub}` if missing (shared with the
 *     local environment, so either can be started first)
 *   - start headscale, then mint the two preauth keys the nodes register
 *     with — they cannot be minted before the control plane exists, which
 *     is why this is a script and not plain `docker compose up`
 *   - start the rest, then wait for an actual SSH banner to come back
 *     through the tailnet
 *
 * That last step is the point: "container is up" says nothing here. A
 * tailnet node is up long before it has registered, learned its peers and
 * accepted MagicDNS, and a suite started in that window fails with
 * `Connection lost before handshake` for reasons that have nothing to do
 * with the plugin.
 *
 * Idempotent: re-running re-checks the keys, mints fresh preauth keys and
 * waits for ready. Existing nodes keep their identity (`TS_AUTH_ONCE`).
 *
 * Used by `npm run test:integration:tailnet` and `npm run test:e2e:tailnet`.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here     = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const compose  = ['compose', '-f', path.join(repoRoot, 'docker-compose.tailnet.yml')];

const keyDir   = path.join(repoRoot, 'docker', 'keys');
const keyPath  = path.join(keyDir, 'id_test');
const runDir   = path.join(repoRoot, 'docker', 'tailnet', 'run');

const HEADSCALE = 'orst-tailnet-headscale';
/** Must match `plugin/test-env/target.ts`. */
const VAULT_HOST = 'vault.tailnet.test';
const SOCKS5_PORT = 1055;
const READY_TIMEOUT_MS = 180_000;

/**
 * The last thing the proxy said, so a timeout can report a cause.
 *
 * Declared here, not beside `waitFor` with the other helpers: the readiness
 * probe runs during the top-level await above, before the rest of this
 * module body is evaluated, so a `let` further down is still in its
 * temporal dead zone when the first stderr chunk arrives.
 */
let lastProxyError = '';

fs.mkdirSync(keyDir, { recursive: true });
fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(path.join(repoRoot, 'docker', 'test-vault'), { recursive: true });

// ─── the keypair, shared with the local environment ────────────────────

if (!fs.existsSync(keyPath)) {
  console.log(`Generating ed25519 keypair at ${keyPath}`);
  run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-q', '-C', 'obsidian-remote-ssh-test']);
} else {
  console.log(`Reusing existing keypair at ${keyPath}`);
}

// ─── control plane first: the nodes need keys it has not minted yet ────

console.log('Starting headscale…');
run('docker', [...compose, 'up', '-d', 'headscale']);
await waitFor('headscale to answer', 60_000, () =>
  spawnSync('docker', ['exec', HEADSCALE, 'headscale', 'users', 'list'],
    { stdio: 'ignore' }).status === 0);

// `users create` fails if it already exists, which is the normal case on a
// re-run — the tailnet's state lives in a docker volume.
spawnSync('docker', ['exec', HEADSCALE, 'headscale', 'users', 'create', 'tester'],
  { stdio: 'ignore' });

for (const node of ['vault', 'client']) {
  // `--user 1`: the tailnet has exactly one user, the `tester` created just
  // above, and headscale numbers users from 1 in a database this script owns
  // — `tailnet:stop` removes the volume, so there is never a second one to
  // collide with. The key check below is what catches it if that ever stops
  // being true, rather than a confusing tailscaled registration failure.
  const key = capture('docker', [
    'exec', HEADSCALE, 'headscale', 'preauthkeys', 'create',
    '--user', '1', '--reusable', '--expiration', '24h',
  ]).trim().split('\n').pop().trim();
  if (!key.startsWith('hskey-')) {
    fail(`headscale did not return a preauth key for ${node}; got: ${key.slice(0, 80)}`);
  }
  fs.writeFileSync(path.join(runDir, `authkey-${node}`), key, { mode: 0o600 });
}
console.log('Minted preauth keys for both nodes.');

// ─── the tailnet itself ────────────────────────────────────────────────

console.log('Starting the tailnet nodes and sshd…');
run('docker', [...compose, 'up', '-d', '--build']);

console.log('Waiting for the vault to answer through the tailnet…');
await waitFor(`an SSH banner from ${VAULT_HOST}`, READY_TIMEOUT_MS, sshBannerReachable);

console.log('');
console.log('Tailnet environment ready.');
console.log('');
console.log(`  host:         ${VAULT_HOST} (MagicDNS, inside the test tailnet)`);
console.log('  port:         22');
console.log('  user:         tester');
console.log(`  private key:  ${keyPath}`);
console.log(`  socks5:       127.0.0.1:${SOCKS5_PORT}`);
console.log('');
console.log('  Run the suites against it with:');
console.log('    npm run test:integration:tailnet');
console.log('    npm run test:e2e:tailnet');
console.log('');

// ─── helpers ───────────────────────────────────────────────────────────

/**
 * Open the same `ProxyCommand` the tests use and wait for the server to
 * announce itself. Anything less — a TCP connect, a container health check —
 * can succeed while the path is still forming.
 */
function sshBannerReachable() {
  return new Promise((resolve) => {
    // stdin must be a pipe we simply never write to. With `'ignore'` the
    // child's stdin is /dev/null, which reports EOF immediately; the proxy
    // then half-closes the socket and sshd drops the connection before it
    // has said anything ("Connection closed by 127.0.0.1 port …").
    //
    // stderr is captured rather than ignored: it carries the only statement
    // of WHY the tailnet is not answering ("proxy refused CONNECT to
    // vault.tailnet.test:22 — host unreachable"). Dropping it left a
    // three-minute timeout whose report was four containers' logs and no
    // mention of the thing the probe itself had just been told.
    const proxy = spawn(process.execPath, [
      path.join(here, 'socks5-connect.mjs'), VAULT_HOST, '22', `127.0.0.1:${SOCKS5_PORT}`,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let seen = '';
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      proxy.kill();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 8_000);

    proxy.stdout.on('data', (chunk) => {
      seen += chunk.toString('utf8');
      if (seen.includes('SSH-')) { clearTimeout(timer); finish(true); }
    });
    proxy.stderr.on('data', (chunk) => { lastProxyError = chunk.toString('utf8').trim(); });
    proxy.on('error', (e) => { lastProxyError = e.message; clearTimeout(timer); finish(false); });
    proxy.on('exit', () => { clearTimeout(timer); finish(seen.includes('SSH-')); });
  });
}

async function waitFor(what, timeoutMs, check) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  dumpLogs();
  fail(
    `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}.` +
    (lastProxyError ? `\nLast proxy error: ${lastProxyError}` : ''),
  );
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: repoRoot });
  if (r.status !== 0) {
    if (r.error?.code === 'ENOENT') fail(`Missing required tool: ${cmd}. Is it on PATH?`);
    process.exit(r.status ?? 1);
  }
}

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: repoRoot });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function dumpLogs() {
  for (const c of ['orst-tailnet-headscale', 'orst-tailnet-vault', 'orst-tailnet-client', 'orst-tailnet-sshd']) {
    console.error(`--- docker logs (${c}) ---`);
    spawnSync('docker', ['logs', '--tail', '60', c], { stdio: 'inherit' });
  }
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
