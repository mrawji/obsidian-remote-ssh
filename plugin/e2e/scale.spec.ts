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

interface Sample {
  tMs: number;
  txBytes: number;
  /** Round trip of the sampling evaluate; null when it hit EVAL_TIMEOUT_MS. */
  evalMs: number | null;
  mdInModel: number | null;
  parsed: number | null;
  clean: boolean | null;
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
const TIMED_OUT = Symbol('timed out');

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
      const files = app?.vault?.getMarkdownFiles?.() ?? [];
      const mc = app?.metadataCache;
      let parsed = 0;
      for (const f of files) if (mc?.getFileCache?.(f)) parsed++;
      return {
        mdInModel: files.length,
        parsed,
        clean: typeof mc?.isCacheClean === 'function' ? mc.isCacheClean() : null,
      };
    }),
    EVAL_TIMEOUT_MS,
  ).catch(() => TIMED_OUT);
  const evalMs = r === TIMED_OUT ? null : Date.now() - evalStart;
  return {
    tMs: Date.now() - t0,
    txBytes: containerTxBytes() - tx0,
    evalMs,
    mdInModel: r === TIMED_OUT ? null : r.mdInModel,
    parsed: r === TIMED_OUT ? null : r.parsed,
    clean: r === TIMED_OUT ? null : r.clean,
  };
}

async function runPass(pass: PassResult['pass']): Promise<PassResult> {
  const expected = fixture.markdownFiles;
  const tx0 = containerTxBytes();
  const t0 = Date.now();
  obsidian = await launchObsidian(shadowVaultPath);

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
      `tx=${(s.txBytes / 1e6).toFixed(1)}MB eval=${s.evalMs ?? 'FROZEN'}ms`,
    );
    // Two clean samples in a row, so a late straggler read is still counted.
    if (samples.length >= 2 && isClean(s) && isClean(samples[samples.length - 2])) break;
    if (s.tMs > BUDGET_MS) { budgetExceeded = true; break; }
    await new Promise((r) => setTimeout(r, SAMPLE_EVERY_MS));
  }

  await obsidian.cleanup();
  obsidian = null;

  const parsedSample = samples.find(isParsed);
  const evals = samples.map((s) => s.evalMs).filter((v): v is number => v !== null);
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
    `${p.maxEvalMs ?? '-'} ms | ${p.frozenSamples} | ${p.budgetExceeded ? 'yes' : 'no'} |`,
  );
  const md = [
    `### Scale: \`${PROFILE.name}\` over \`${NET.name}\``,
    '',
    `${fixture.markdownFiles.toLocaleString()} notes, ${mdMB.toFixed(0)} MB markdown` +
      (fixture.attachmentBytes ? `, ${(fixture.attachmentBytes / 1e6).toFixed(0)} MB attachments` : '') +
      ` · link: ${NET.delayMs ?? 0} ms delay, ${NET.rateMbit ?? 'unshaped'} Mbit` +
      ` · budget ${BUDGET_MS / 60_000} min/pass`,
    '',
    '| pass | connected | tree | parsed | clean | bytes sent | ÷ markdown | max eval | frozen samples | over budget |',
    '|---|---|---|---|---|---|---|---|---|---|',
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
