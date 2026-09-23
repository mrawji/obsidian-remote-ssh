import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  launchObsidian,
  driveConnectFlow,
  findShadowVaultPath,
  type ObsidianHandle,
} from './helpers/obsidian';
import { scaffoldTestVault, type ScaffoldResult } from './helpers/vault-scaffold';
import { assertSshdReachable } from './helpers/sshd';
import { logPathFor, readLogEntries } from './helpers/log-oracle';
import { SCALE_PROFILES, seedScaleFixture, type SeededFixture } from './helpers/scale-fixture';
import { NET_PROFILES, applyNetProfile, clearNetProfile, containerTxBytes } from './helpers/netem';

/**
 * SCALE BENCHMARK (#513) — how does a big vault behave, end to end?
 *
 * #513 measured the ratio on a 5-file vault: Obsidian reads 100% of the
 * markdown on every start, because every note in `vault.fileMap` gets parsed
 * into `metadataCache`, and its persisted cache is not reused. A ratio says
 * nothing about wall time. This spec measures, at real sizes and over a shaped
 * link, what a user waits for:
 *
 *   connected ... the shadow vault shows the root (first markdown in the model)
 *   tree ........ every markdown file is in `vault.fileMap` (BackgroundIndexer)
 *   parsed ...... every markdown file has a `metadataCache` entry, i.e. links,
 *                 backlinks, graph and Dataview see the whole vault
 *   clean ....... `metadataCache.isCacheClean()`, Obsidian's own "done"
 *
 * plus bytes the server sent (container tx counter, SSH framing included) and
 * how long the renderer took to answer a trivial evaluate, as a proxy for UI
 * freezes. Pass 1 is a cold start on a fresh shadow vault. Pass 2 relaunches
 * the same shadow vault, which is where a reused cache would show.
 *
 * It REPORTS, it does not judge speed: a slow pass is a finding, not a failure.
 * It fails only when the harness is broken (the vault never connects).
 *
 * Selected by env, one combination per run (see e2e-scale.yml):
 *   SCALE_PROFILE     s | m | l | xl-md | xl-mixed   (helpers/scale-fixture.ts)
 *   SCALE_NET         lan | wan                       (helpers/netem.ts)
 *   SCALE_BUDGET_MIN  per-pass budget, default 30
 */

const PROFILE = SCALE_PROFILES[process.env.SCALE_PROFILE ?? 's'];
const NET = NET_PROFILES[process.env.SCALE_NET ?? 'lan'];
const BUDGET_MS = Number(process.env.SCALE_BUDGET_MIN ?? 30) * 60_000;
const SAMPLE_EVERY_MS = 10_000;
/** A sampling evaluate that takes longer than this is recorded as a freeze. */
const EVAL_TIMEOUT_MS = 30_000;

const RESULTS_DIR = path.resolve(__dirname, '..', 'scale-results');
const TIMED_OUT: unique symbol = Symbol('timed out');

interface Sample {
  tMs: number;
  txBytes: number;
  /** Round trip of the sampling evaluate; null when it hit EVAL_TIMEOUT_MS. */
  evalMs: number | null;
  mdInModel: number | null;
  parsed: number | null;
  clean: boolean | null;
  /** `vault.readBinary` calls so far this launch: what metadataCache reads through. */
  reads: number | null;
  readAvgMs: number | null;
  readMaxMs: number | null;
  /** Most `vault.readBinary` calls in flight at once. 1 = strictly sequential. */
  readInflightMax: number | null;
  /** `vault.readBinary` calls that threw. Never folded into the averages. */
  readErrors: number | null;
  /** metadataCache's fileCache: entries, and how many carry a parsed hash. */
  cacheEntries: number | null;
  cacheWithHash: number | null;
}

interface PassResult {
  pass: 'cold' | 'relaunch';
  samples: Sample[];
  connectedMs: number | null;
  treeMs: number | null;
  parsedMs: number | null;
  cleanMs: number | null;
  /** Bytes sent by the server from launch until `parsed` (or the end of the pass). */
  bytesToParsed: number;
  maxEvalMs: number | null;
  frozenSamples: number;
  budgetExceeded: boolean;
  /** How the launch ended: a real window close, or the harness's signal. */
  shutdown?: 'closed' | 'signalled';
  /** Adapter-level stat/read timings, outside Obsidian's indexing queue. */
  adapterProbe?: unknown;
  reads: number | null;
  readAvgMs: number | null;
  readInflightMax: number | null;
  /** metadataCache internals right after launch: whether its cache survived startup. */
  cacheAtStart: unknown;
}

let obsidian: ObsidianHandle | null = null;
let scaffold: ScaffoldResult;
let fixture: SeededFixture;
let shadowVaultPath: string;
let seedMs = 0;
const passes: PassResult[] = [];

test.describe.configure({ mode: 'serial', retries: 0 });

test.beforeAll(async () => {
  test.setTimeout(BUDGET_MS + 30 * 60_000);
  if (!PROFILE) throw new Error(`unknown SCALE_PROFILE "${process.env.SCALE_PROFILE}"`);
  if (!NET) throw new Error(`unknown SCALE_NET "${process.env.SCALE_NET}"`);
  await assertSshdReachable();

  const seedStart = Date.now();
  fixture = seedScaleFixture(PROFILE);
  seedMs = Date.now() - seedStart;

  applyNetProfile(NET);

  // The first connect only creates the shadow vault; it runs in the scaffold
  // window and is not measured.
  scaffold = scaffoldTestVault({ remotePath: fixture.remotePath });
  obsidian = await launchObsidian(scaffold.vaultPath);
  await driveConnectFlow(obsidian.page);
  shadowVaultPath = await findShadowVaultPath(scaffold.vaultPath, 60_000);
  await obsidian.cleanup();
  obsidian = null;
});

test.afterAll(async () => {
  await obsidian?.cleanup().catch(() => { /* best effort */ });
  clearNetProfile();
  scaffold?.cleanup();
  writeReport();
});

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function sample(page: Page, t0: number, tx0: number): Promise<Sample> {
  const evalStart = Date.now();
  const r = await withTimeout(
    page.evaluate(() => {
      interface MdFile { path: string }
      const app = (window as unknown as {
        app?: {
          vault?: { getMarkdownFiles?: () => MdFile[] };
          metadataCache?: {
            getFileCache?: (f: MdFile) => unknown;
            isCacheClean?: () => boolean;
          };
        };
      }).app;
      // Time every vault.readBinary, the call metadataCache's sequential work
      // queue makes per note. Installed on the first sample, before the
      // remote tree lands, so no read is missed.
      interface ReadStats {
        count: number; totalMs: number; maxMs: number; inflight: number; inflightMax: number;
        /** Reads that threw. Obsidian may retry one, so these are counted, not averaged. */
        errors: number;
      }
      const w = window as unknown as { __SCALE_READS__?: ReadStats };
      const vault = (app?.vault ?? null) as
        | { readBinary?: (f: MdFile) => Promise<ArrayBuffer>; __scaleWrapped?: boolean }
        | null;
      if (vault?.readBinary && !vault.__scaleWrapped) {
        const stats: ReadStats = {
          count: 0, totalMs: 0, maxMs: 0, inflight: 0, inflightMax: 0, errors: 0,
        };
        w.__SCALE_READS__ = stats;
        const orig = vault.readBinary.bind(vault);
        vault.readBinary = async (f: MdFile) => {
          const t = performance.now();
          stats.inflight++;
          stats.inflightMax = Math.max(stats.inflightMax, stats.inflight);
          try {
            const r = await orig(f);
            const d = performance.now() - t;
            stats.count++;
            stats.totalMs += d;
            stats.maxMs = Math.max(stats.maxMs, d);
            return r;
          } catch (e) {
            stats.errors++;
            throw e;
          } finally {
            stats.inflight--;
          }
        };
        vault.__scaleWrapped = true;
      }
      const rs = w.__SCALE_READS__;
      const files = app?.vault?.getMarkdownFiles?.() ?? [];
      const mc = app?.metadataCache as {
        getFileCache?: (f: MdFile) => unknown;
        isCacheClean?: () => boolean;
        fileCache?: Record<string, { hash: string }>;
      } | undefined;
      const fc = Object.values(mc?.fileCache ?? {});
      let parsed = 0;
      for (const f of files) if (mc?.getFileCache?.(f)) parsed++;
      return {
        mdInModel: files.length,
        parsed,
        clean: typeof mc?.isCacheClean === 'function' ? mc.isCacheClean() : null,
        reads: rs?.count ?? 0,
        readAvgMs: rs && rs.count ? Math.round(rs.totalMs / rs.count) : null,
        readMaxMs: rs ? Math.round(rs.maxMs) : null,
        readInflightMax: rs?.inflightMax ?? 0,
        readErrors: rs?.errors ?? 0,
        cacheEntries: fc.length,
        cacheWithHash: fc.filter((e) => e.hash).length,
      };
    }),
    EVAL_TIMEOUT_MS,
  ).catch((): typeof TIMED_OUT => TIMED_OUT);
  const evalMs = r === TIMED_OUT ? null : Date.now() - evalStart;
  return {
    tMs: Date.now() - t0,
    txBytes: containerTxBytes() - tx0,
    evalMs,
    mdInModel: r === TIMED_OUT ? null : r.mdInModel,
    parsed: r === TIMED_OUT ? null : r.parsed,
    clean: r === TIMED_OUT ? null : r.clean,
    reads: r === TIMED_OUT ? null : r.reads,
    readAvgMs: r === TIMED_OUT ? null : r.readAvgMs,
    readMaxMs: r === TIMED_OUT ? null : r.readMaxMs,
    readInflightMax: r === TIMED_OUT ? null : r.readInflightMax,
    readErrors: r === TIMED_OUT ? null : r.readErrors,
    cacheEntries: r === TIMED_OUT ? null : r.cacheEntries,
    cacheWithHash: r === TIMED_OUT ? null : r.cacheWithHash,
  };
}

/**
 * Time the adapter directly, outside Obsidian's indexing queue: `stat` (one
 * RPC) and `readBinary` (two RPCs cold, since the adapter revalidates with a
 * stat) on distinct notes, sequentially.
 *
 * metadataCache reads one note at a time and each `vault.readBinary` costs
 * ~42 ms on LAN and on a 40 ms WAN alike, so the cost is not the link. This
 * says how much of it is our read path and how much is Obsidian's.
 */
async function probeAdapter(page: Page, paths: string[]): Promise<unknown> {
  return withTimeout(page.evaluate(async (ps: string[]) => {
    const adapter = (window as unknown as {
      app?: { vault?: { adapter?: {
        stat?: (p: string) => Promise<unknown>;
        readBinary?: (p: string) => Promise<ArrayBuffer>;
      } } };
    }).app?.vault?.adapter;
    if (!adapter?.stat || !adapter?.readBinary) return { error: 'no adapter' };
    let errors = 0;
    // A failed call returns null and is counted, never averaged: a fast
    // rejection (a dropped channel, a lossy WAN profile) would otherwise look
    // like a fast read and pull the figure this probe exists to establish.
    const time = async (fn: () => Promise<unknown>): Promise<number | null> => {
      const t = performance.now();
      try {
        await fn();
      } catch {
        errors++;
        return null;
      }
      return performance.now() - t;
    };
    const ok = (xs: Array<number | null>): number[] => xs.filter((v): v is number => v !== null);
    const statMs: Array<number | null> = [];
    for (const p of ps) statMs.push(await time(() => adapter.stat!(p)));
    const readMs: Array<number | null> = [];
    for (const p of ps) readMs.push(await time(() => adapter.readBinary!(p)));
    // Second pass over the same notes: now warm in the ReadCache, so what is
    // left is the revalidating stat plus our own overhead.
    const rereadMs: Array<number | null> = [];
    for (const p of ps) rereadMs.push(await time(() => adapter.readBinary!(p)));
    // The same round trip WITHOUT our adapter in the way: straight to the
    // plugin's RpcClient. From plain Node this call measures under 1 ms
    // (tests/integration/rpc.latency.test.ts) while the adapter measures
    // ~41 ms here, so this says whether the cost is our adapter layer or the
    // transport as the renderer sees it.
    const plugin = (window as unknown as {
      app?: { plugins?: { plugins?: Record<string, {
        conn?: { rpcConnection?: { rpc?: { call?: (m: string, p: unknown) => Promise<unknown> } } };
      }> } };
    }).app?.plugins?.plugins?.['remote-ssh'];
    const rpc = plugin?.conn?.rpcConnection?.rpc;
    const rpcMs: Array<number | null> = [];
    if (rpc?.call) {
      const remoteBase = ps[0]?.split('/')[0] ?? '';
      void remoteBase;
      for (const p of ps) {
        rpcMs.push(await time(() => rpc.call!('fs.stat', { path: p })));
      }
    }

    // Controls: if a bare setTimeout(0) also takes tens of ms, the renderer's
    // task queue is being throttled (an occluded Electron window under Xvfb)
    // and the RPC figure says nothing about a real desktop.
    const timerMs: Array<number | null> = [];
    for (let i = 0; i < 30; i++) timerMs.push(await time(() => new Promise((r) => setTimeout(r, 0))));
    const microMs: Array<number | null> = [];
    for (let i = 0; i < 30; i++) microMs.push(await time(() => Promise.resolve()));
    const avg = (xs: Array<number | null>) => {
      const good = ok(xs);
      return good.length ? Math.round(good.reduce((a, b) => a + b, 0) / good.length) : null;
    };
    return {
      n: ps.length, errors,
      statAvgMs: avg(statMs), readAvgMs: avg(readMs), rereadAvgMs: avg(rereadMs),
      rawRpcStatAvgMs: rpcMs.length ? avg(rpcMs) : null,
      setTimeout0AvgMs: avg(timerMs), microtaskAvgMs: avg(microMs),
      hidden: document.hidden, visibility: document.visibilityState,
    };
  }, paths), EVAL_TIMEOUT_MS * 6).catch((): typeof TIMED_OUT => TIMED_OUT);
}

/**
 * Close Obsidian the way a user does, and only fall back to the harness's
 * SIGTERM if that doesn't take.
 *
 * This matters for what is being measured. Obsidian writes its metadata cache
 * to IndexedDB with `durability: "relaxed"`, so a process that is signalled
 * away can lose the last writes — and then the next launch has no cache to
 * reuse, whatever the plugin did. #513 concluded "reuse is genuinely refused"
 * from a harness that killed Obsidian, so the conclusion has to be re-taken on
 * a clean shutdown.
 */
async function quitObsidian(handle: ObsidianHandle): Promise<'closed' | 'signalled'> {
  try {
    await handle.page.evaluate(() => { window.close(); });
  } catch {
    // The window may already be gone; fall through to the wait.
  }
  const exited = await new Promise<boolean>((resolve) => {
    if (handle.process.exitCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), 20_000);
    handle.process.on('exit', () => { clearTimeout(timer); resolve(true); });
  });
  await handle.cleanup().catch(() => { /* best effort */ });
  return exited ? 'closed' : 'signalled';
}

/**
 * What metadataCache kept through startup: its IndexedDB-backed `fileCache`
 * (path → mtime/size/hash) against the model's `TFile.stat`. On a relaunch,
 * a note is read again unless both match and the hash's metadata is present.
 * Key names and stats only, never content.
 */
async function cacheAtStart(page: Page): Promise<unknown> {
  return withTimeout(page.evaluate(async () => {
    interface Stat { mtime: number; size: number }
    const app = (window as unknown as {
      app?: {
        appId?: string;
        vault?: { getMarkdownFiles?: () => Array<{ path: string; stat: Stat }> };
        metadataCache?: {
          initialized?: boolean;
          fileCache?: Record<string, { mtime: number; size: number; hash: string }>;
          metadataCache?: Record<string, unknown>;
        };
      };
    }).app;
    const mc = app?.metadataCache;
    const fc = mc?.fileCache ?? {};
    const files = app?.vault?.getMarkdownFiles?.() ?? [];
    const entries = Object.values(fc);
    // The metadata cache lives in IndexedDB under `<appId>-cache`. If appId
    // is not stable per vault, every launch starts from an empty cache no
    // matter what anyone does.
    const dbs = typeof indexedDB.databases === 'function'
      ? (await indexedDB.databases()).map((d) => d.name ?? '?')
      : ['unsupported'];
    return {
      appId: app?.appId ?? null,
      databases: dbs,
      initialized: mc?.initialized ?? null,
      modelMarkdown: files.length,
      fileCacheEntries: entries.length,
      withHash: entries.filter((e) => e.hash).length,
      metadataEntries: Object.keys(mc?.metadataCache ?? {}).length,
      statMatches: files.filter((f) => fc[f.path]?.mtime === f.stat.mtime && fc[f.path]?.size === f.stat.size).length,
      first: files.slice(0, 3).map((f) => ({ path: f.path, stat: f.stat, cache: fc[f.path] ?? null })),
    };
  }), EVAL_TIMEOUT_MS).catch((): typeof TIMED_OUT => TIMED_OUT);
}

async function runPass(pass: PassResult['pass']): Promise<PassResult> {
  const expected = fixture.markdownFiles;
  const tx0 = containerTxBytes();
  const t0 = Date.now();
  obsidian = await launchObsidian(shadowVaultPath);
  const cache = await cacheAtStart(obsidian.page);
  console.warn(`[scale ${PROFILE.name}/${NET.name} ${pass}] cache at start: ${JSON.stringify(cache)}`);

  const samples: Sample[] = [];
  const firstAt = (pred: (s: Sample) => boolean): number | null =>
    samples.find(pred)?.tMs ?? null;
  const isParsed = (s: Sample) => s.parsed === expected;
  const isClean = (s: Sample) => isParsed(s) && s.clean === true;

  let budgetExceeded = false;
  for (;;) {
    const s = await sample(obsidian.page, t0, tx0);
    samples.push(s);
    console.warn(
      `[scale ${PROFILE.name}/${NET.name} ${pass}] t=${(s.tMs / 1000).toFixed(0)}s ` +
      `model=${s.mdInModel}/${expected} parsed=${s.parsed} clean=${s.clean} ` +
      `tx=${(s.txBytes / 1e6).toFixed(1)}MB eval=${s.evalMs ?? 'FROZEN'}ms ` +
      `reads=${s.reads} avg=${s.readAvgMs}ms max=${s.readMaxMs}ms inflightMax=${s.readInflightMax} ` +
      `cache=${s.cacheEntries}/${s.cacheWithHash} hashed errors=${s.readErrors}`,
    );
    // Two clean samples in a row, so a late straggler read is still counted.
    if (samples.length >= 2 && isClean(s) && isClean(samples[samples.length - 2])) break;
    if (s.tMs > BUDGET_MS) { budgetExceeded = true; break; }
    await new Promise((r) => setTimeout(r, SAMPLE_EVERY_MS));
  }

  // Adapter-level timings on 30 notes the index has already been through.
  const probePaths = await obsidian.page.evaluate(() => {
    const files = (window as unknown as {
      app?: { vault?: { getMarkdownFiles?: () => Array<{ path: string }> } };
    }).app?.vault?.getMarkdownFiles?.() ?? [];
    return files.slice(0, 30).map((f) => f.path);
  }).catch(() => [] as string[]);
  const adapterProbe = probePaths.length ? await probeAdapter(obsidian.page, probePaths) : null;
  console.warn(`[scale ${PROFILE.name}/${NET.name} ${pass}] adapter probe: ${JSON.stringify(adapterProbe)}`);

  // Let IndexedDB's relaxed-durability writes land, then close the window
  // rather than signalling the process, so the next pass measures reuse.
  await new Promise((r) => setTimeout(r, 5_000));
  const how = await quitObsidian(obsidian);
  console.warn(`[scale ${PROFILE.name}/${NET.name} ${pass}] shutdown: ${how}`);
  obsidian = null;
  for (const e of readLogEntries(logPathFor(shadowVaultPath))) {
    if (/TreeSnapshot|reconciled|BackgroundIndexer: (complete|full walk)/.test(e.msg ?? '')) {
      console.warn(`[scale ${PROFILE.name}/${NET.name} ${pass}] log: ${e.msg}`);
    }
  }

  const parsedSample = samples.find(isParsed);
  const evals = samples.map((s) => s.evalMs).filter((v): v is number => v !== null);
  const last = [...samples].reverse().find((s) => s.reads !== null);
  return {
    pass,
    samples,
    connectedMs: firstAt((s) => (s.mdInModel ?? 0) >= 1),
    treeMs: firstAt((s) => s.mdInModel === expected),
    parsedMs: parsedSample?.tMs ?? null,
    cleanMs: firstAt(isClean),
    bytesToParsed: (parsedSample ?? samples[samples.length - 1]).txBytes,
    maxEvalMs: evals.length ? Math.max(...evals) : null,
    frozenSamples: samples.filter((s) => s.evalMs === null).length,
    budgetExceeded,
    shutdown: how,
    adapterProbe: adapterProbe === TIMED_OUT ? 'timed out' : adapterProbe,
    reads: last?.reads ?? null,
    readAvgMs: last?.readAvgMs ?? null,
    readInflightMax: last?.readInflightMax ?? null,
    cacheAtStart: cache === TIMED_OUT ? 'timed out' : cache,
  };
}

function fmtS(ms: number | null): string {
  return ms === null ? 'not reached' : `${(ms / 1000).toFixed(0)} s`;
}

function writeReport(): void {
  if (!fixture) return;
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const base = `scale-${PROFILE.name}-${NET.name}`;
  fs.writeFileSync(
    path.join(RESULTS_DIR, `${base}.json`),
    JSON.stringify({ profile: PROFILE, net: NET, fixture, seedMs, passes }, null, 2),
  );

  const mdMB = fixture.markdownBytes / 1e6;
  const rows = passes.map((p) =>
    `| ${p.pass} | ${fmtS(p.connectedMs)} | ${fmtS(p.treeMs)} | ${fmtS(p.parsedMs)} | ` +
    `${fmtS(p.cleanMs)} | ${(p.bytesToParsed / 1e6).toFixed(0)} MB | ` +
    `${(p.bytesToParsed / fixture.markdownBytes).toFixed(2)} | ` +
    `${p.maxEvalMs ?? '-'} ms | ${p.frozenSamples} | ${p.budgetExceeded ? 'yes' : 'no'} | ` +
    `${p.reads ?? '-'} | ${p.readAvgMs ?? '-'} ms | ${p.readInflightMax ?? '-'} |`,
  );
  const md = [
    `### Scale: \`${PROFILE.name}\` over \`${NET.name}\``,
    '',
    `${fixture.markdownFiles.toLocaleString()} notes, ${mdMB.toFixed(0)} MB markdown` +
      (fixture.attachmentBytes ? `, ${(fixture.attachmentBytes / 1e6).toFixed(0)} MB attachments` : '') +
      ` · link: ${NET.delayMs ?? 0} ms delay, ${NET.rateMbit ?? 'unshaped'} Mbit` +
      ` · budget ${BUDGET_MS / 60_000} min/pass`,
    '',
    '| pass | connected | tree | parsed | clean | bytes sent | ÷ markdown | max eval | frozen samples | over budget | reads | avg read | reads in flight (max) |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(RESULTS_DIR, `${base}.md`), md);
}

test('pass 1: cold start on a fresh shadow vault', async () => {
  test.setTimeout(BUDGET_MS + 10 * 60_000);
  const r = await runPass('cold');
  passes.push(r);
  expect(r.connectedMs, 'the shadow vault never showed a single note: the harness is broken')
    .not.toBeNull();
});

test('pass 2: relaunch the same shadow vault', async () => {
  test.setTimeout(BUDGET_MS + 10 * 60_000);
  const r = await runPass('relaunch');
  passes.push(r);
  expect(r.connectedMs, 'the relaunch never showed a single note: the harness is broken')
    .not.toBeNull();
});
