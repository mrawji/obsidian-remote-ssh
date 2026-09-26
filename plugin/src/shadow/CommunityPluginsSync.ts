import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';
import { sanitiseStateKey } from './vaultNaming';
import type { SharedConfigReader, SharedConfigWriter } from './SharedObsidianConfigSync';
import { writeFileAtomic } from '../util/writeFileAtomic';

// ─── community-plugins list round-trip (#429 / #342 / uninstall) ─────────
//
// `community-plugins.json` is the *enabled community plugins* list. It is
// round-tripped rather than copied verbatim like the shared-config files:
// a remote list that omitted `remote-ssh` would, written as-is, disable the
// very plugin doing the sync. The marketplace installer re-fetches any
// binaries the merged list names but that aren't staged locally yet.
//
// Convergence is a 3-WAY MERGE against a per-device BASE — the converged
// list as it stood at the END of the last successful round-trip ON THIS
// DEVICE ({@link communityPluginsBasePath}). Not a union: a union is
// monotonic, so an uninstall never reached the remote and the next pull
// RESURRECTED the plugin. A union cannot tell "I never had it" from "I
// removed it"; only a base can.
//
//     added   = local  \ base   -> add to remote
//     removed = base   \ local  -> remove from remote
//     added   = remote \ base   -> add to local
//     removed = base   \ remote -> remove from local
//
// Rules, all encoded in {@link mergePluginIds}:
//
//  - `remote-ssh` (SELF_PLUGIN_ID) is NEVER removable from either side.
//  - NO BASE YET (first run, or a re-bootstrapped shadow vault): a removal
//    is indistinguishable from never-had, so fall back to the union.
//    Nothing is lost; removals just don't propagate until the first
//    successful push writes a base.
//  - TIE-BREAK — concurrent ADD on A vs REMOVE on B: **ADD WINS**, which
//    falls out of the definitions above. Re-uninstalling a plugin someone
//    else re-installed is one click; silently losing one you just
//    installed is invisible data loss.
//
// Only the PUSH commits the base, once both sides hold the converged list.
// `pullCommunityPlugins` must never write it: a pull-only caller
// (`preSpawnPull`) would record the pulled list as the base, and the push
// later in the real connect would then read `base \ remote` as a remote
// removal of everything this device had added locally — deleting the
// user's own plugins. It also keeps the merge idempotent, so the
// pre-spawn-pull → connect-pull → connect-push sequence cannot
// double-apply a removal.

/** The plugin's own id — always kept enabled across a round-trip. */
export const SELF_PLUGIN_ID = 'remote-ssh';

/**
 * THIS DEVICE's base snapshot of the enabled-plugin list for `profileId`:
 *
 *   <stateRoot>/state/<profile-id>/community-plugins.base.json
 *
 * A sibling of the shadow `vaults/` dir, deliberately outside every vault.
 * It must be per-device and must not sync — a base that synced would record
 * another machine's view and removals would ping-pong. Under a vault's
 * `<configDir>/` it would be write-through-mirrored to the remote by
 * `SftpDataAdapter.writeThroughConfig` and redirected by `PathMapper`;
 * outside the vault root it is also invisible to Obsidian and out of the
 * populate. Not under `vaults/` either: `findShadowByProfileId` enumerates
 * that dir, and `uniqueVaultDir` could collide with a profile named "state".
 */
export function communityPluginsBasePath(stateRoot: string, profileId: string): string {
  return path.join(
    stateRoot, 'state', sanitiseStateKey(profileId), 'community-plugins.base.json',
  );
}

/**
 * Pull the remote enabled-plugin list into the shadow vault, 3-way
 * merged against this device's base (see the section comment above)
 * with `remote-ssh` forced on. A remote list that's absent or not a
 * valid id array leaves the local list untouched (never clobbered)
 * and — crucially — contributes NO removals: a remote we could not read
 * must never look like "every plugin was uninstalled elsewhere".
 *
 * `basePath` is optional; omitting it (or pointing at a base that does
 * not exist yet) degrades to the historical UNION behaviour.
 */
export async function pullCommunityPlugins(
  reader: SharedConfigReader,
  remoteConfigDir: string,
  localConfigDir: string,
  basePath?: string | null,
): Promise<{ pulled: boolean; merged: string[] }> {
  const basename = 'community-plugins.json';
  const remoteRel = `${remoteConfigDir}/${basename}`;
  const localPath = path.join(localConfigDir, basename);

  fs.mkdirSync(localConfigDir, { recursive: true });
  const local = readPluginIdList(localPath);
  if (local === null) {
    // Same rule as for an unreadable remote: a list we could not read gets
    // no say. Writing a merge now would overwrite whatever is really there.
    logger.warn(`pullCommunityPlugins: local ${basename} unreadable; leaving it alone this round`);
    return { pulled: false, merged: [] };
  }

  let remote: string[] | null = null;
  try {
    if (await reader.exists(remoteRel)) {
      remote = parsePluginIdList(await reader.read(remoteRel));
      if (remote === null) {
        logger.warn(
          `pullCommunityPlugins: remote ${basename} is not a valid id array; keeping local list`,
        );
      }
    }
  } catch (e) {
    logger.warn(`pullCommunityPlugins: ${basename} skipped (${errorMessage(e)})`);
  }

  const base = readPluginIdBase(basePath);
  const merged = remote === null
    // Nothing readable on the remote → it gets no say this round. Keep
    // the local list as-is (only forcing `remote-ssh` on); do NOT let
    // `base \ remote` infer removals from a list we never saw.
    ? mergePluginIds(local, local, null, SELF_PLUGIN_ID)
    : mergePluginIds(local, remote, base, SELF_PLUGIN_ID);

  const changed =
    merged.length !== local.length || merged.some((id, i) => id !== local[i]);
  if (changed) writePluginIdListAtomic(localPath, merged);

  logger.info(
    `pullCommunityPlugins: merged [${merged.join(', ')}] ` +
    `(changed=${changed}, base=${base ? `[${base.join(', ')}]` : 'none'})`,
  );
  return { pulled: remote !== null, merged };
}

/**
 * Push the local enabled-plugin list to the remote — 3-way merged
 * against the remote's CURRENT list and this device's base, with
 * `remote-ssh` forced on — then record the converged list as the new
 * base (both sides now hold it).
 *
 * Still self-protecting against clobber: it re-reads the remote first,
 * so a plugin another machine enabled (absent from the base AND from
 * this device's list = a remote *addition*) is preserved. If the remote
 * HAS the file but it can't be read or parsed, it aborts rather than
 * overwrite what it couldn't see — and leaves the base alone, so a
 * pending removal is simply retried on the next connect. A genuinely
 * absent remote file is seeded from local (no removals inferred: an
 * absent remote is not an emptied one).
 */
export async function pushCommunityPlugins(
  rw: SharedConfigReader & SharedConfigWriter,
  remoteConfigDir: string,
  localConfigDir: string,
  basePath?: string | null,
): Promise<{ pushed: boolean }> {
  const basename = 'community-plugins.json';
  const remoteRel = `${remoteConfigDir}/${basename}`;
  const local = readPluginIdList(path.join(localConfigDir, basename));
  if (local === null) {
    // An unreadable local list must never reach the remote. With a base in
    // play it would read as "this device uninstalled everything", and the
    // next pull on every other device would uninstall them too.
    logger.warn('pushCommunityPlugins: local list unreadable; not pushing (avoid clobber)');
    return { pushed: false };
  }

  /** null = the remote has no list at all (fresh remote) — NOT an empty one. */
  let remote: string[] | null = null;
  try {
    if (await rw.exists(remoteRel)) {
      const parsed = parsePluginIdList(await rw.read(remoteRel));
      if (parsed === null) {
        logger.warn('pushCommunityPlugins: remote list is not a valid id array; not pushing (avoid clobber)');
        return { pushed: false };
      }
      remote = parsed;
    }
  } catch (e) {
    logger.warn(`pushCommunityPlugins: cannot read remote (${errorMessage(e)}); not pushing (avoid clobber)`);
    return { pushed: false };
  }

  const base = readPluginIdBase(basePath);
  const ids = remote === null
    // Seed a fresh remote from local. No base removals: "the remote has
    // no list" is not "the remote deleted everything".
    ? mergePluginIds(local, local, null, SELF_PLUGIN_ID)
    : mergePluginIds(local, remote, base, SELF_PLUGIN_ID);

  // No-op when the remote already equals the converged list — avoid
  // churn. The base is still committed: both sides DO hold `ids`, and
  // without this the steady state would never record a base at all.
  if (remote !== null && remote.length === ids.length && remote.every((id, i) => id === ids[i])) {
    writePluginIdBase(basePath, ids);
    return { pushed: false };
  }
  try {
    await rw.write(remoteRel, JSON.stringify(ids) + '\n');
    // Only now do BOTH sides hold `ids` — commit the base. A write that
    // throws leaves the old base, so the merge is retried next connect.
    writePluginIdBase(basePath, ids);
    logger.info(`pushCommunityPlugins: pushed [${ids.join(', ')}]`);
    return { pushed: true };
  } catch (e) {
    logger.warn(`pushCommunityPlugins: push failed (${errorMessage(e)})`);
    return { pushed: false };
  }
}

// ─── plugin code round-trip (#429b — BRAT / non-marketplace) ────────────
//
// The enabled-plugins LIST round-trips (above) and the marketplace
// installer fetches binaries for plugins on Obsidian's registry. But a
// BRAT / sideloaded plugin isn't on the marketplace, so its code would
// never reach another machine. These methods round-trip the plugin
// *code* through the remote vault's `.obsidian/plugins/<id>/` (the
// canonical store) so such plugins load everywhere. Code only — the
// plugin's own `data.json` (settings, sometimes secrets) is left alone.
//
// Convergence is VERSION-ORDERED, not last-writer-wins: pull only when
// the remote is strictly newer (or the plugin is absent locally), push
// only when the local copy is strictly newer (or the remote lacks it).
// A plain "content differs" gate would let a machine still on an old
// version downgrade a plugin the rest of the fleet already upgraded,
// and the two sides would ping-pong forever (review: #429b).

// NOTE: synced over a UTF-8 TEXT channel (readText/writeText). Every
// entry MUST be text. Do NOT add binary assets (.png/.woff/…) here —
// the UTF-8 round-trip would corrupt them.
export const PLUGIN_BINARY_FILES = ['manifest.json', 'main.js', 'styles.css'] as const;

/**
 * Pull a plugin's code from the remote into the local shadow when the
 * plugin is ABSENT locally or the remote is a STRICTLY NEWER version
 * (by manifest `version`) — so a plugin enabled/updated on another
 * machine (incl. BRAT / non-marketplace) reaches here and loads on the
 * next vault open. Never downgrades a local copy, never touches
 * `data.json`. `remote-ssh` is skipped (self-managed).
 */
export async function pullPluginBinaries(
  reader: SharedConfigReader,
  remoteConfigDir: string,
  localConfigDir: string,
  pluginIds: readonly string[],
): Promise<{ pulled: string[] }> {
  const pulled: string[] = [];
  for (const id of pluginIds) {
    if (id === SELF_PLUGIN_ID) continue;
    const localPluginDir = path.join(localConfigDir, 'plugins', id);
    const remoteManifest = `${remoteConfigDir}/plugins/${id}/manifest.json`;
    try {
      if (!(await reader.exists(remoteManifest))) continue; // no code on the remote
      const remoteVer = parseManifestVersion(await reader.read(remoteManifest));
      const localManifest = path.join(localPluginDir, 'manifest.json');
      const localVer = fs.existsSync(localManifest)
        ? parseManifestVersion(fs.readFileSync(localManifest, 'utf-8'))
        : null;
      // Skip unless absent locally, or the remote is strictly newer.
      if (localVer !== null && !versionGt(remoteVer, localVer)) continue;
      let staged = false;
      for (const file of PLUGIN_BINARY_FILES) {
        const remoteRel = `${remoteConfigDir}/plugins/${id}/${file}`;
        if (!(await reader.exists(remoteRel))) continue;
        const content = await reader.read(remoteRel);
        fs.mkdirSync(localPluginDir, { recursive: true });
        writeFileAtomic(path.join(localPluginDir, file), content);
        staged = true;
      }
      if (staged) pulled.push(id);
    } catch (e) {
      logger.warn(`pullPluginBinaries: ${id} skipped (${errorMessage(e)})`);
    }
  }
  if (pulled.length) logger.info(`pullPluginBinaries: staged [${pulled.join(', ')}]`);
  return { pulled };
}

/**
 * Push a plugin's local code to the remote when the remote LACKS it or
 * the local copy is a STRICTLY NEWER version — so other machines can
 * pull it. Never downgrades the remote, never pushes `data.json`;
 * byte-identical files are skipped to avoid churn. `remote-ssh` skipped.
 */
export async function pushPluginBinaries(
  rw: SharedConfigReader & SharedConfigWriter,
  remoteConfigDir: string,
  localConfigDir: string,
  pluginIds: readonly string[],
): Promise<{ pushed: string[] }> {
  const pushed: string[] = [];
  for (const id of pluginIds) {
    if (id === SELF_PLUGIN_ID) continue;
    const localPluginDir = path.join(localConfigDir, 'plugins', id);
    const localManifest = path.join(localPluginDir, 'manifest.json');
    if (!fs.existsSync(localManifest)) continue; // nothing to push
    const remoteManifest = `${remoteConfigDir}/plugins/${id}/manifest.json`;
    try {
      const localVer = parseManifestVersion(fs.readFileSync(localManifest, 'utf-8'));
      const remoteVer = (await rw.exists(remoteManifest))
        ? parseManifestVersion(await rw.read(remoteManifest))
        : null;
      // Skip unless the remote lacks it, or the local copy is newer.
      if (remoteVer !== null && !versionGt(localVer, remoteVer)) continue;
      let sent = false;
      for (const file of PLUGIN_BINARY_FILES) {
        const localFile = path.join(localPluginDir, file);
        if (!fs.existsSync(localFile)) continue;
        const content = fs.readFileSync(localFile, 'utf-8');
        const remoteRel = `${remoteConfigDir}/plugins/${id}/${file}`;
        if ((await rw.exists(remoteRel)) && (await rw.read(remoteRel)) === content) continue; // identical
        await rw.write(remoteRel, content);
        sent = true;
      }
      if (sent) pushed.push(id);
    } catch (e) {
      logger.warn(`pushPluginBinaries: ${id} skipped (${errorMessage(e)})`);
    }
  }
  if (pushed.length) logger.info(`pushPluginBinaries: pushed [${pushed.join(', ')}]`);
  return { pushed };
}

/** Parse a manifest.json body's dotted-numeric `version` ([0] when absent/unparseable = oldest). */
function parseManifestVersion(body: string): number[] {
  try {
    const v = (JSON.parse(body) as { version?: unknown }).version;
    if (typeof v !== 'string') return [0];
    const parts = v.split('.').map((s) => parseInt(s, 10)).map((n) => (Number.isFinite(n) ? n : 0));
    return parts.length ? parts : [0];
  } catch {
    return [0];
  }
}

/** True when dotted-numeric version `a` is strictly greater than `b` (missing segments = 0). */
function versionGt(a: number[], b: number[]): boolean {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Parse a community-plugins.json body into a string-id array, or null if malformed. */
function parsePluginIdList(content: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) return null;
    return (parsed as unknown[]).filter((s): s is string => typeof s === 'string');
  } catch {
    return null;
  }
}

/**
 * Enabled-plugin ids from a local `.obsidian/community-plugins.json`
 * ([] when absent/malformed) — the set whose binaries the connect flow
 * round-trips via {@link pullPluginBinaries}/{@link pushPluginBinaries}.
 */
export function readEnabledPluginIds(localConfigDir: string): string[] {
  // Binaries only: an unreadable list means "round-trip nothing this time",
  // which costs a retry, not data.
  return readPluginIdList(path.join(localConfigDir, 'community-plugins.json')) ?? [];
}

/**
 * A local community-plugins.json as an id array, or **null** when it could
 * not be read or did not parse.
 *
 * The difference matters as much here as it does for the remote. Once a
 * merge base exists, `[]` means "this device uninstalled everything", and
 * `pushCommunityPlugins` propagates that to the remote and from there to
 * every other device. An unreadable file is not that: Obsidian rewrites
 * this file whenever the user toggles a plugin, and the read is a plain
 * `readFileSync` with no lock, so a read that lands mid-write — or after a
 * crash left the file truncated — must mean "no data this round", never
 * "everything is gone".
 */
function readPluginIdList(localPath: string): string[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(localPath, 'utf-8');
  } catch (e) {
    // ENOENT is a legitimate empty state: no plugins have ever been
    // enabled in this vault. Anything else (EACCES, EIO, a directory)
    // is a read we cannot trust.
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    logger.warn(`readPluginIdList: cannot read ${localPath} (${errorMessage(e)})`);
    return null;
  }
  const parsed = parsePluginIdList(raw);
  if (parsed === null) {
    logger.warn(`readPluginIdList: ${localPath} is not a valid id array; treating as unreadable`);
  }
  return parsed;
}

/**
 * The 3-way converged enabled-plugin list.
 *
 * `base` is what BOTH sides held at the end of the last successful
 * round-trip on this device (null = none recorded yet). An id is
 * REMOVED iff it is in the base but has since disappeared from a side
 * that once had it (`base \ local` ∪ `base \ remote`); everything else
 * present on either side is kept — so an id absent from the base is an
 * ADDITION and always survives (the add-wins tie-break). `required`
 * (`remote-ssh`) is never removable and is always present.
 *
 * With `base === null` the removal set is empty and this degrades
 * EXACTLY to the historical order-preserving union of local + remote —
 * the documented first-run fallback (nothing can be lost, but a removal
 * cannot be inferred either).
 *
 * Order is local-first, then remote-only additions, then `required`:
 * deterministic and identical in the pull and the push, so once both
 * sides converge the push's equality check sees a true no-op.
 */
function mergePluginIds(
  local: string[],
  remote: string[],
  base: string[] | null,
  required: string,
): string[] {
  const removed = new Set<string>();
  if (base) {
    const inLocal = new Set(local);
    const inRemote = new Set(remote);
    for (const id of base) {
      if (!inLocal.has(id) || !inRemote.has(id)) removed.add(id);
    }
  }
  // The one plugin that may never be uninstalled — it IS the sync.
  removed.delete(required);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...local, ...remote, required]) {
    if (removed.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * This device's base snapshot ([] is meaningful — "both sides were
 * empty"), or null when there is no usable base: no path given, the
 * file doesn't exist yet (first run / freshly re-bootstrapped shadow),
 * or it is malformed. null means "fall back to the union" — never
 * "everything was removed", which is why a malformed base is degraded
 * rather than treated as empty.
 */
function readPluginIdBase(basePath: string | null | undefined): string[] | null {
  if (!basePath) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(basePath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(`communityPlugins base: unreadable ${basePath} (${errorMessage(e)}); falling back to union`);
    }
    return null;
  }
  const parsed = parsePluginIdList(raw);
  if (parsed === null) {
    logger.warn(`communityPlugins base: malformed ${basePath}; falling back to union`);
  }
  return parsed;
}

/**
 * Record the converged list as this device's new base. Best-effort: a
 * failure here only costs the NEXT connect its removal inference (it
 * degrades to a union), so it must never fail the round-trip that has
 * already written both sides.
 */
function writePluginIdBase(basePath: string | null | undefined, ids: string[]): void {
  if (!basePath) return;
  try {
    fs.mkdirSync(path.dirname(basePath), { recursive: true });
    writePluginIdListAtomic(basePath, ids);
  } catch (e) {
    logger.warn(`communityPlugins base: failed to record ${basePath} (${errorMessage(e)})`);
  }
}

/** Atomic (tmp + rename) write of an id array as JSON. */
function writePluginIdListAtomic(localPath: string, ids: string[]): void {
  writeFileAtomic(localPath, JSON.stringify(ids) + '\n');
}
