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
 * Obsidian config files this vault round-trips to the remote so a settings
 * change survives a shadow-window restart (#342: without the pull half, the
 * next startup read a stale local copy and settings appeared to evaporate).
 *
 * "Shared" is historical — these are **per-device**. `PathMapper` redirects
 * each basename into this client's `<configDir>/user/<client-id>/` subtree,
 * so the round-trip reads and writes THIS device's copy: a remote backup
 * per machine, without two of them colliding on one `<configDir>/app.json`
 * (the perpetual write-conflict this round-trip used to cause).
 *
 * `workspace.json` is deliberately NOT here — per-client UI state that
 * `PathMapper` already redirects AND that Obsidian rewrites constantly.
 */
export const SHARED_OBSIDIAN_CONFIG_FILES = [
  'app.json',
  'appearance.json',
  'core-plugins.json',
  'hotkeys.json',
] as const satisfies readonly string[];

/**
 * Pull the allowlist from the remote into the local shadow vault's config
 * dir, closing the #342 round-trip gap.
 *
 * Remote bytes are written **verbatim** (key order and formatting survive)
 * but only after `JSON.parse` confirms they are well-formed, and atomically
 * (tmp + rename): a truncated remote file, or an interrupted pull, must not
 * leave Obsidian unable to read its own settings on the next start — which
 * is the #342 symptom itself.
 *
 * Two kinds of non-pull:
 *  - `skipped`: every basename not pulled, absent OR errored — the superset,
 *    kept for back-compat and logging.
 *  - `errored`: the remote HAD the file but it could not be pulled (read or
 *    exists threw, corrupt JSON, write or rename failed). Absent on the
 *    remote is not an error — a fresh remote vault legitimately has none.
 *    The connect flow raises a Notice on a non-empty `errored`, so a
 *    transient SSH hiccup does not silently leave settings stale.
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
 * The other half of the #342 round-trip. Without it a settings change made
 * in the shadow window only ever lives on local disk: the next session's
 * `pullSharedObsidianConfig` finds nothing new and the change "evaporates".
 *
 * Symmetric with the pull — each local file is `JSON.parse`-validated before
 * it is sent, so a half-written one (Obsidian saving mid-flush) never
 * clobbers a healthy remote copy. Absent locally is skipped, not an error; a
 * remote write that throws is `errored` for the caller to surface.
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
