import type { RemoteVerifier } from './remote-verifier';

/**
 * Force-revert of the REMOTE fixture state a spec seeded.
 *
 * Why this has to exist at all
 * ---------------------------
 * The docker test vault is SHARED, single-worker, and PERSISTS across specs
 * within a run. Anything a spec leaves on the remote is inherited by every spec
 * that runs after it — and a fixture plugin left enabled in the remote
 * `.obsidian/community-plugins.json` is not inert: the next spec's shadow vault
 * PULLS it in at connect (`src/main.ts:632-670` → pullCommunityPlugins →
 * pullPluginBinaries), stages its code, and loads it. That is how a fixture from
 * one spec reddens an unrelated, previously-passing spec (`sync.spec.ts`).
 *
 * And the remote does NOT clean itself up. `pushCommunityPlugins`
 * (`ShadowVaultBootstrap.ts:698-702`) computes a monotonic UNION of remote+local:
 * the enabled list can only ever GROW. Deleting a fixture plugin locally cannot
 * remove it from the remote list — that is exactly the product defect
 * `plugin-code-roundtrip.spec.ts` test 6 pins, and it means test-harness cleanup
 * is the ONLY thing standing between a fixture and the rest of the suite.
 *
 * So every reverting step here is deliberately unconditional and independent:
 * each is wrapped so one failure cannot abort the rest, and the whole thing runs
 * from `afterAll` (never `afterEach`, never inside a test) so a FAILING test —
 * which is the expected outcome for the specs that pin defects — still cleans up.
 */

/** The shared (identity-scoped) enabled-plugin list on the remote. */
export const COMMUNITY_PLUGINS_REL = '.obsidian/community-plugins.json';

/** Root of the per-device config subtree: `.obsidian/user/<clientId>/…`. */
const USER_ROOT_REL = '.obsidian/user';

/**
 * The remote's `community-plugins.json` exactly as it was before a spec touched
 * it. `raw === null` means the file DID NOT EXIST — restoring must then delete
 * it, not write `[]`: an empty list and no list are different inputs to
 * `pullCommunityPlugins`, and a fresh docker vault has no list at all.
 */
export interface CommunityPluginsSnapshot {
  readonly raw: string | null;
}

/** Tolerant read of a `community-plugins.json` body: absent / junk → no ids. */
export function parseIdList(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Capture the remote enabled list byte-for-byte (null when absent). */
export async function captureCommunityPlugins(
  remote: RemoteVerifier,
): Promise<CommunityPluginsSnapshot> {
  return { raw: await remote.readFile(COMMUNITY_PLUGINS_REL) };
}

/**
 * Put the remote enabled list back to EXACTLY the captured bytes — or delete it
 * if there was no such file. Byte-exact rather than "remove our ids" on purpose:
 * a re-serialised list differs in whitespace and member order from whatever
 * wrote it, and the point is that the next spec sees the remote it would have
 * seen had this spec never run.
 */
export async function restoreCommunityPlugins(
  remote: RemoteVerifier,
  snapshot: CommunityPluginsSnapshot,
): Promise<void> {
  if (snapshot.raw === null) {
    await remote.removeFile(COMMUNITY_PLUGINS_REL);
  } else {
    await remote.writeFile(COMMUNITY_PLUGINS_REL, snapshot.raw);
  }
}

/** Drop `ids` from the remote enabled list, leaving every other id untouched. */
export async function dropFromCommunityPlugins(
  remote: RemoteVerifier,
  ids: readonly string[],
): Promise<void> {
  const raw = await remote.readFile(COMMUNITY_PLUGINS_REL);
  if (raw === null) return;
  const kept = parseIdList(raw).filter((id) => !ids.includes(id));
  await remote.writeFile(COMMUNITY_PLUGINS_REL, `${JSON.stringify(kept)}\n`);
}

/**
 * Remove every trace of a fixture plugin's CODE from the remote: the shared
 * identity path `.obsidian/plugins/<id>/`, and any per-device copy the product
 * made under `.obsidian/user/<clientId>/plugins/<id>/` (`PathMapper.ts:19,289`).
 *
 * The client dirs are DISCOVERED (`listDir('.obsidian/user')`), never computed:
 * the client id is derived at runtime by the plugin, and a harness that
 * re-derived it (from the hostname, say) would silently miss the real directory
 * the moment that derivation changed — leaving the fixture behind while looking
 * like it had cleaned up.
 *
 * Does NOT touch the enabled list: `afterAll` restores that byte-exactly from a
 * snapshot, and the `beforeAll` pre-clean uses `dropFromCommunityPlugins`.
 */
export async function purgeFixturePlugin(remote: RemoteVerifier, id: string): Promise<void> {
  await remote.rmrf(`.obsidian/plugins/${id}`);
  for (const clientDir of await remote.listDir(USER_ROOT_REL)) {
    await remote.rmrf(`${USER_ROOT_REL}/${clientDir}/plugins/${id}`);
  }
}

/**
 * Remove every remote entry under `dir` whose name starts with one of
 * `prefixes` — the notes and folders a spec seeds under a run STAMP. Prefix
 * matching (rather than the exact names of THIS run) is what makes a crashed
 * previous run, whose stamp is long gone, still cleanable.
 */
export async function purgePrefixedEntries(
  remote: RemoteVerifier,
  prefixes: readonly string[],
  dir = '',
): Promise<void> {
  if (prefixes.length === 0) return;
  for (const entry of await remote.listDir(dir)) {
    if (!prefixes.some((prefix) => entry.startsWith(prefix))) continue;
    await remote.rmrf(dir ? `${dir}/${entry}` : entry);
  }
}

/** Everything a spec puts on the shared remote, and therefore owes back. */
export interface FixtureFootprint {
  /** Plugin ids the spec seeds under `.obsidian/plugins/`. */
  readonly pluginIds: readonly string[];
  /**
   * Filename PREFIXES (not the stamped names of a single run) of the notes and
   * folders the spec seeds at the vault root — e.g. `e2e-fs-` for
   * `e2e-fs-<stamp>-control.md`.
   */
  readonly notePrefixes?: readonly string[];
}

/** Run `step`, swallowing its failure: one broken step must not abort the rest. */
async function attempt(label: string, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (err) {
    // Cleanup is best-effort by construction — an `afterAll` that throws turns
    // one honest red into a cascade of harness reds and buries the real one.
    console.warn(`[remote-reset] ${label} failed: ${String(err)}`);
  }
}

/**
 * DEFENSIVE PRE-CLEAN, for `beforeAll`. A previous run that crashed (or was
 * killed mid-spec) leaves its fixtures on the shared remote; without this, a
 * spec inherits them and its very first assertion is already testing someone
 * else's garbage.
 *
 * Call this BEFORE `captureCommunityPlugins`, so the snapshot — and therefore
 * what `afterAll` restores — is a CLEAN baseline rather than one that still
 * names the fixture ids.
 */
export async function preCleanRemoteFixtures(
  remote: RemoteVerifier,
  footprint: FixtureFootprint,
): Promise<void> {
  for (const id of footprint.pluginIds) {
    await attempt(`pre-clean plugin ${id}`, () => purgeFixturePlugin(remote, id));
  }
  await attempt('pre-clean enabled list', () =>
    dropFromCommunityPlugins(remote, footprint.pluginIds),
  );
  await attempt('pre-clean seeded notes', () =>
    purgePrefixedEntries(remote, footprint.notePrefixes ?? []),
  );
}

/**
 * FULL REVERT, for `afterAll`. Runs regardless of how the tests ended (Playwright
 * runs `afterAll` after failures too), and every step is independently guarded so
 * a failure in one cannot skip the others — a half-reverted remote is precisely
 * the cross-spec contamination this file exists to prevent.
 */
export async function resetRemoteFixtures(
  remote: RemoteVerifier,
  footprint: FixtureFootprint,
  snapshot: CommunityPluginsSnapshot,
): Promise<void> {
  await attempt('restore community-plugins.json', () =>
    restoreCommunityPlugins(remote, snapshot),
  );
  for (const id of footprint.pluginIds) {
    await attempt(`purge plugin ${id}`, () => purgeFixturePlugin(remote, id));
  }
  await attempt('purge seeded notes', () =>
    purgePrefixedEntries(remote, footprint.notePrefixes ?? []),
  );
}
