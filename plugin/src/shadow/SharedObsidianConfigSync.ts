import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';

/**
 * The narrow read surface `pullSharedObsidianConfig` needs from the
 * remote. `SftpDataAdapter` satisfies this structurally (it has both
 * `exists` and a string-returning `read`), so the connect flow and
 * the Layer-2 test helper pass the patched adapter directly. Kept
 * minimal so `shadow/` gains no dependency on `adapter/`.
 */
export interface SharedConfigReader {
  exists(normalizedPath: string): Promise<boolean>;
  read(normalizedPath: string): Promise<string>;
}

/**
 * The narrow write surface `pushSharedObsidianConfig` needs — the
 * other half of the #342 round-trip. `SftpDataAdapter.write`
 * satisfies it structurally, so the connect flow passes the patched
 * adapter directly (symmetric with `SharedConfigReader`).
 */
export interface SharedConfigWriter {
  write(normalizedPath: string, content: string): Promise<void>;
}

// ─── shared-config round-trip (#342) ────────────────────────────────────

/**
 * Obsidian config files this vault round-trips to the remote so a
 * settings change survives a shadow-window restart (#342: without the
 * pull half, the next startup read a stale local copy and settings
 * appeared to evaporate).
 *
 * These are now **per-device**, not shared: `PathMapper` redirects each
 * basename into this client's `<configDir>/user/<client-id>/` subtree
 * (they were added to `DEFAULT_PRIVATE_PATTERN_BASENAMES`). So the
 * round-trip below reads/writes THIS device's own copy — giving each
 * machine a remote backup + cross-session persistence without two
 * devices ever colliding on one shared `<configDir>/app.json` (the
 * perpetual write-conflict this round-trip used to cause). The name is
 * kept for back-compat; "shared" is historical.
 *
 * `workspace.json` is deliberately NOT here — it's per-client UI state
 * `PathMapper` already redirects AND that Obsidian rewrites constantly.
 */
export const SHARED_OBSIDIAN_CONFIG_FILES = [
  'app.json',
  'appearance.json',
  'core-plugins.json',
  'hotkeys.json',
] as const satisfies readonly string[];

/**
 * Pull the shared-config allowlist from the remote into the local
 * shadow vault's config dir, closing the #342 round-trip gap.
 *
 * The remote bytes are written **verbatim** (no re-serialise, so
 * key order / formatting survive), but only after `JSON.parse`
 * confirms they're well-formed: a truncated or half-written remote
 * file must not clobber a healthy local copy and leave Obsidian
 * unable to read its own settings on next start (which is the very
 * #342 symptom this method exists to fix). The write is atomic
 * (tmp + rename) so an interrupted pull can't tear the local file.
 *
 * The result distinguishes two kinds of non-pull:
 *  - `skipped`: every basename not pulled (absent OR errored) — the
 *    superset, kept for back-compat / logging.
 *  - `errored`: the subset where the remote *had* the file but it
 *    couldn't be pulled (read/exists threw, corrupt JSON, write or
 *    rename failed). A file absent on the remote is NOT errored (a
 *    fresh remote vault legitimately has none yet). The connect flow
 *    surfaces a Notice when `errored` is non-empty so a transient
 *    SSH hiccup doesn't silently leave settings stale — the #342
 *    symptom this method exists to prevent.
 *
 * Static because both call sites (the connect flow in `main.ts`
 * and the Layer-2 test helper) have a reader + paths but not
 * necessarily a constructed `ShadowVaultBootstrap` to hand.
 */
export async function pullSharedObsidianConfig(
  reader: SharedConfigReader,
  /** Vault-relative config dir, e.g. `.obsidian` (`app.vault.configDir`). */
  remoteConfigDir: string,
  /** Absolute local config dir, i.e. `ShadowVaultLayout.configDir`. */
  localConfigDir: string,
): Promise<{ pulled: string[]; skipped: string[]; errored: string[] }> {
  const pulled: string[] = [];
  const skipped: string[] = [];
  const errored: string[] = [];

  fs.mkdirSync(localConfigDir, { recursive: true });

  for (const basename of SHARED_OBSIDIAN_CONFIG_FILES) {
    const remoteRel = `${remoteConfigDir}/${basename}`;
    try {
      if (!(await reader.exists(remoteRel))) {
        skipped.push(basename);
        continue;
      }
      const content = await reader.read(remoteRel);
      try {
        JSON.parse(content);
      } catch {
        // Corrupt/partial remote file — do NOT overwrite the
        // (possibly healthy) local copy with broken JSON.
        logger.warn(
          `pullSharedObsidianConfig: ${basename} on remote is not valid JSON; ` +
          'keeping the local copy untouched',
        );
        skipped.push(basename);
        errored.push(basename);
        continue;
      }
      const dest = path.join(localConfigDir, basename);
      const tmp = `${dest}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, content, 'utf-8');
      try {
        fs.renameSync(tmp, dest);
      } catch (renameErr) {
        // rename failed (perms / cross-device) — drop the orphan
        // tmp so it can't accumulate or be mistaken for real data,
        // then rethrow into the outer catch for the skip+error path.
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        throw renameErr;
      }
      pulled.push(basename);
    } catch (e) {
      // Best-effort: a single unreadable file must not abort the
      // others or fail the connect. The stale local copy (if any)
      // stays; logged so it's diagnosable. The remote *had* the
      // file (exists() passed or threw) so this counts as errored,
      // not a benign absence.
      logger.warn(
        `pullSharedObsidianConfig: ${basename} skipped (${errorMessage(e)})`,
      );
      skipped.push(basename);
      errored.push(basename);
    }
  }

  logger.info(
    `pullSharedObsidianConfig: pulled [${pulled.join(', ')}], ` +
    `skipped [${skipped.join(', ')}], errored [${errored.join(', ')}]`,
  );
  return { pulled, skipped, errored };
}

/**
 * Push the local shadow vault's shared-config files to the remote —
 * the other half of the #342 round-trip. Without this, a settings
 * change made in the shadow window only ever lives on the local
 * shadow disk: the next session's `pullSharedObsidianConfig` finds
 * nothing new on the remote and the change "evaporates".
 *
 * Symmetric with the pull: each local file is `JSON.parse`-validated
 * before it is sent, so a half-written local file (Obsidian saving
 * mid-flush) never clobbers a healthy remote copy. Absent local
 * files are skipped (not an error — a fresh vault legitimately has
 * none yet); a remote write that throws is `errored` so the caller
 * can surface it instead of silently losing settings again.
 *
 * Static for the same reason as the pull: callers have a writer +
 * paths but not necessarily a constructed instance.
 */
export async function pushSharedObsidianConfig(
  writer: SharedConfigWriter,
  /** Vault-relative config dir, e.g. `.obsidian` (`app.vault.configDir`). */
  remoteConfigDir: string,
  /** Absolute local config dir, i.e. `ShadowVaultLayout.configDir`. */
  localConfigDir: string,
): Promise<{ pushed: string[]; skipped: string[]; errored: string[] }> {
  const pushed: string[] = [];
  const skipped: string[] = [];
  const errored: string[] = [];

  for (const basename of SHARED_OBSIDIAN_CONFIG_FILES) {
    const localPath = path.join(localConfigDir, basename);
    let content: string;
    try {
      content = fs.readFileSync(localPath, 'utf-8');
    } catch {
      // Absent locally — nothing to push (fresh vault). Not an error.
      skipped.push(basename);
      continue;
    }
    try {
      JSON.parse(content);
    } catch {
      // Obsidian caught mid-save, or a corrupt local file — do NOT
      // push broken JSON over a healthy remote copy.
      logger.warn(
        `pushSharedObsidianConfig: local ${basename} is not valid JSON; ` +
        'not pushing (keeping remote copy untouched)',
      );
      skipped.push(basename);
      errored.push(basename);
      continue;
    }
    try {
      await writer.write(`${remoteConfigDir}/${basename}`, content);
      pushed.push(basename);
    } catch (e) {
      // A transient SSH error must not abort the rest or lose the
      // change silently — surface it (errored) so the caller can
      // Notice and the next connect retries.
      logger.warn(
        `pushSharedObsidianConfig: ${basename} push failed (${errorMessage(e)})`,
      );
      skipped.push(basename);
      errored.push(basename);
    }
  }

  logger.info(
    `pushSharedObsidianConfig: pushed [${pushed.join(', ')}], ` +
    `skipped [${skipped.join(', ')}], errored [${errored.join(', ')}]`,
  );
  return { pushed, skipped, errored };
}
