import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import { deployTestDaemon, LOCAL_DAEMON_BINARY, type DeployedDaemon } from './helpers/deployDaemonOnce';
import { TEST_PRIVATE_KEY } from './helpers/makeAdapter';
import { buildRpcClient, type RpcClientHandle } from './helpers/multiclientRpc';

/**
 * How long ONE RPC round trip takes, from plain Node (#513).
 *
 * The scale benchmark found that Obsidian indexes notes one at a time and
 * each `vault.readBinary` costs ~41 ms — the same on LAN as over a 40 ms
 * shaped WAN, so not the link. Timed at the adapter it is the same figure
 * for a bare `fs.stat` (one RPC), and the renderer is not throttled there
 * (`setTimeout(0)` measures 4 ms, the window is visible).
 *
 * What that leaves is either our RPC path / the daemon, or Electron's
 * renderer. This measures the same call from an ordinary Node process
 * against the same daemon over the same SSH transport. A few ms here means
 * the cost is the renderer; ~40 ms here means it is ours, and the number to
 * chase is in the client, the SSH channel or the daemon.
 *
 * It REPORTS. The only assertion is that the calls worked, so a slow CI
 * runner cannot turn a measurement into a red build.
 */

if (!fs.existsSync(TEST_PRIVATE_KEY)) {
  throw new Error(
    `Integration test keypair missing at ${TEST_PRIVATE_KEY}. ` +
    'Run `npm run sshd:start` from the repo root before `npm run test:integration`.',
  );
}
if (!fs.existsSync(LOCAL_DAEMON_BINARY)) {
  throw new Error(
    `Daemon binary missing at ${LOCAL_DAEMON_BINARY}. ` +
    'Run `npm run build:server` before `npm run test:integration`.',
  );
}

const CALLS = 30;

function summarise(samples: number[]): { avg: number; median: number; min: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    avg: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length),
    median: Math.round(sorted[Math.floor(sorted.length / 2)]),
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
  };
}

describe('integration: RPC round-trip latency (#513)', () => {
  let daemon: DeployedDaemon;
  let client: RpcClientHandle;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = `rpc-latency-${stamp}`;
  const note = `${dir}/probe.md`;

  beforeAll(async () => {
    daemon = await deployTestDaemon();
    client = await buildRpcClient(daemon.result.remoteSocketPath, daemon.result.token, 'rpc-latency');
    await client.conn.rpc.call('fs.mkdir', { path: dir, recursive: true });
    await client.conn.rpc.call('fs.writeBinary', {
      path: note,
      contentBase64: Buffer.from('# probe\n\n' + 'x'.repeat(5_000), 'utf8').toString('base64'),
    });
  }, 120_000);

  afterAll(async () => {
    try { await client?.conn.rpc.call('fs.rmdir', { path: dir, recursive: true }); } catch { /* best effort */ }
    await client?.close();
  });

  it('times fs.stat and fs.readBinary, sequentially', async () => {
    const time = async (fn: () => Promise<unknown>): Promise<number> => {
      const t = performance.now();
      await fn();
      return performance.now() - t;
    };

    const statMs: number[] = [];
    for (let i = 0; i < CALLS; i++) statMs.push(await time(() => client.conn.rpc.call('fs.stat', { path: note })));
    const readMs: number[] = [];
    for (let i = 0; i < CALLS; i++) {
      readMs.push(await time(() => client.conn.rpc.call('fs.readBinary', { path: note })));
    }

    const stat = summarise(statMs);
    const read = summarise(readMs);
    console.warn(
      `[rpc-latency] node → daemon, ${CALLS} sequential calls each\n` +
      `  fs.stat        avg=${stat.avg}ms median=${stat.median}ms min=${stat.min}ms max=${stat.max}ms\n` +
      `  fs.readBinary  avg=${read.avg}ms median=${read.median}ms min=${read.min}ms max=${read.max}ms\n` +
      '  (Obsidian\'s renderer measures ~41 ms for the same calls — see #513)',
    );

    expect(statMs).toHaveLength(CALLS);
    expect(readMs).toHaveLength(CALLS);
  }, 120_000);
});
