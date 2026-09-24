import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import { SftpClient } from '../../src/ssh/SftpClient';
import { AuthResolver } from '../../src/ssh/AuthResolver';
import { SecretStore } from '../../src/ssh/SecretStore';
import { HostKeyStore } from '../../src/ssh/HostKeyStore';
import {
  buildTestProfile,
  makeTestClient,
  TEST_PRIVATE_KEY,
  TEST_VAULT,
  type TestClient,
} from './helpers/makeAdapter';
import {
  applyNetProfile,
  clearNetProfile,
  containerTxBytes,
  NET_PROFILES,
} from '../../e2e/helpers/netem';

/**
 * The large-vault collapse (#513), reproduced small.
 *
 * The 50,000-note E2E benchmark takes an hour and 5 GB of fixture, but nothing
 * about the failure needs either. What it needs is **more content read than the
 * read cache can hold**: entries get evicted, the evicted ones are fetched
 * again, and on the big run that sustained re-fetch is where everything came
 * apart — `evictions: 2,625` at 171 s, the session in `reconnecting` by 370 s,
 * 9,756 reads failed outright, renderer wedged at 698 s.
 *
 * The ratio is what matters, not the size. 4.8 MB of notes through a 1 MB cache
 * is the same regime and runs in seconds, against the real SFTP transport and
 * the real `SftpDataAdapter`, so the read path can actually be iterated on. The
 * E2E scale run stays as the end-to-end check.
 *
 * Two invariants are asserted — the two things that broke on the big run:
 *   - every read returns its note (the big run lost ~9,000)
 *   - the session is still up at the end
 *
 * Everything else (ms/read, hits, evictions, re-fetch count) is REPORTED, not
 * asserted: those numbers are the point of having a fast loop, and pinning them
 * to thresholds on shared CI hardware would only buy flakes.
 */

if (!fs.existsSync(TEST_PRIVATE_KEY)) {
  throw new Error(
    `Integration test keypair missing at ${TEST_PRIVATE_KEY}. ` +
    'Run `npm run sshd:start` from the repo root first.',
  );
}

/** 4.8 MB of notes through a 1 MB cache — as over budget as 5 GB is to 64 MiB. */
const NOTES = 240;
const NOTE_BYTES = 20_000;
const CACHE_BYTES = 1024 * 1024;
/** Whole-vault passes. The first fills the cache; the rest are the re-fetch regime. */
const PASSES = 3;
/** How many notes to seed at once. Setup cost only — not part of any measurement. */
const SEED_CONCURRENCY = 8;

/**
 * Link shaping. Unshaped by default so the test stays a couple of seconds and
 * can gate CI; `CACHE_OVERFLOW_NET=wan` re-runs the same sweeps over a 40 ms /
 * 100 Mbit link, which is where the re-fetch volume actually hurts. Both are
 * the same code path — only the milliseconds change.
 */
const NET = NET_PROFILES[process.env.CACHE_OVERFLOW_NET ?? 'lan'] ?? NET_PROFILES.lan;

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const vaultRoot = `${TEST_VAULT}/cache-overflow-${stamp}`;
const notePaths = Array.from({ length: NOTES }, (_, i) => `n${i}.md`);
const noteBody = (i: number) => `# n${i}\n\n${'x'.repeat(NOTE_BYTES)}`;

let boot: SftpClient;

beforeAll(async () => {
  boot = new SftpClient(new AuthResolver(new SecretStore()), new HostKeyStore());
  await boot.connect(buildTestProfile('cache-overflow-boot'));
  await boot.mkdirp(vaultRoot);

  let next = 0;
  await Promise.all(Array.from({ length: SEED_CONCURRENCY }, async () => {
    for (let i = next++; i < NOTES; i = next++) {
      await boot.writeBinary(`${vaultRoot}/${notePaths[i]}`, Buffer.from(noteBody(i), 'utf8'));
    }
  }));

  // Shape only after seeding — the fixture is setup cost, not measurement.
  applyNetProfile(NET);
}, 300_000);

afterAll(async () => {
  try { clearNetProfile();                  } catch { /* best effort */ }
  try { await boot?.rmdir(vaultRoot, true); } catch { /* best effort */ }
  try { await boot?.disconnect();           } catch { /* best effort */ }
});

interface SweepResult {
  reads: number;
  failures: number;
  firstError: string | null;
  elapsedMs: number;
  /** Bytes the server actually put on the wire — the re-fetch made visible. */
  txBytes: number;
}

/** Read every note `PASSES` times through the adapter, counting what breaks. */
async function sweep(client: TestClient, concurrency: number): Promise<SweepResult> {
  const queue: string[] = [];
  for (let pass = 0; pass < PASSES; pass++) queue.push(...notePaths);

  let next = 0;
  let failures = 0;
  let firstError: string | null = null;
  const txBefore = containerTxBytes();
  const started = Date.now();

  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let i = next++; i < queue.length; i = next++) {
      const rel = queue[i];
      try {
        const text = await client.adapter.read(rel);
        if (!text.startsWith('# ')) throw new Error(`truncated read of ${rel}`);
      } catch (e) {
        failures++;
        firstError ??= String((e as Error)?.message ?? e).slice(0, 200);
      }
    }
  }));

  const elapsedMs = Date.now() - started;
  return {
    reads: queue.length,
    failures,
    firstError,
    elapsedMs,
    txBytes: containerTxBytes() - txBefore,
  };
}

function report(label: string, client: TestClient, r: SweepResult): void {
  const s = client.readCache.stats();
  const content = NOTES * NOTE_BYTES;
  console.warn(
    `[cache-overflow ${label}/${NET.name}] ${r.reads} reads of ${NOTES} notes ` +
    `(${(content / 1e6).toFixed(1)} MB of content, ${(CACHE_BYTES / 1e6).toFixed(1)} MB cache) ` +
    `in ${(r.elapsedMs / 1000).toFixed(1)}s = ${(r.elapsedMs / r.reads).toFixed(1)} ms/read\n` +
    `  wire  ${(r.txBytes / 1e6).toFixed(1)} MB sent = ` +
    `${(r.txBytes / content).toFixed(1)}x the vault (1.0x would mean every note travelled once)\n` +
    `  cache ${JSON.stringify(s)}\n` +
    `  failures ${r.failures}${r.firstError ? ` — first: ${r.firstError}` : ''}`,
  );
}

describe('integration: reading more than the read cache holds (#513)', () => {
  let client: TestClient | null = null;
  afterAll(async () => { await client?.disconnect(); });

  it('survives a sequential sweep — the shape Obsidian\'s indexer actually reads in', async () => {
    client = await makeTestClient({
      clientId: 'overflow-seq',
      vaultRoot,
      label: 'overflow-seq',
      readCacheBytes: CACHE_BYTES,
    });

    const r = await sweep(client, 1);
    report('sequential', client, r);

    // If nothing was evicted the vault fit the cache and this proves nothing.
    expect(client.readCache.stats().evictions,
      'the working set must exceed the cache, or there is no re-fetch to measure')
      .toBeGreaterThan(0);
    expect(r.failures, 'the 50k run lost ~9,000 reads in this regime').toBe(0);
    expect(client.ssh.isAlive(), 'and took the SSH session down with it').toBe(true);
  }, 600_000);

  it('survives every read fired at once — and is far faster that way', async () => {
    // The counter-case to the sequential sweep, and the measurement that
    // retired the in-flight cap this file was written to justify: nothing
    // fails here, and on a shaped link it beats sequential by two orders of
    // magnitude (2.2 vs 226.5 ms/read at 40 ms RTT). Whatever took the
    // 50,000-note session down, it was not concurrency.
    const burst = await makeTestClient({
      clientId: 'overflow-burst',
      vaultRoot,
      label: 'overflow-burst',
      readCacheBytes: CACHE_BYTES,
    });
    try {
      const r = await sweep(burst, NOTES * PASSES);
      report('burst', burst, r);

      expect(burst.readCache.stats().evictions).toBeGreaterThan(0);
      expect(r.failures, 'firing them all at once must not lose reads').toBe(0);
      expect(burst.ssh.isAlive(), 'nor drop the session').toBe(true);
    } finally {
      await burst.disconnect();
    }
  }, 600_000);
