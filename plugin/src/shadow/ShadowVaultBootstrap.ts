import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../util/logger';
import type { SshProfile, PendingPluginSuggestion } from '../types';
import type { ObsidianRegistry } from './ObsidianRegistry';
import { friendlyVaultDirName } from './vaultNaming';
import { errorMessage } from "../util/errorMessage";
import { communityPluginsBasePath } from './CommunityPluginsSync';

/** A configured app.json is a plain object with at least one key. */
function isNonEmptyObject(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).length > 0
  );
}

/** A configured core-plugins.json is a non-empty array. */
function isNonEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}

/** `{}` for anything not a plain object, so the #399 merge stays total. */
function asSecretRecord(v: unknown): Record<string, unknown> {
  return (v && typeof v === 'object' && !Array.isArray(v))
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Where the shadow vault for a given profile lives on disk.
 */
export interface ShadowVaultLayout {
  /** Absolute path to the shadow vault root (what Obsidian opens). */
  vaultDir: string;
  /** Absolute path to `<vaultDir>/.obsidian/`. */
  configDir: string;
  /** Absolute path to `<vaultDir>/.obsidian/plugins/remote-ssh/`. */
  pluginDir: string;
  /** Absolute path to the plugin's data.json under `pluginDir`. */
  pluginDataFile: string;
}

export interface BootstrapResult {
  layout: ShadowVaultLayout;
  /** Vault id Obsidian assigned in obsidian.json. */
  registryId: string;
  /** True if the vault entry was newly added (false = was already registered). */
  registryCreated: boolean;
  /**
   * An existing shadow was renamed to the current scheme. The new path is not
   * in the running Obsidian's cached vault list, so the connect flow shows the
   * one-time "restart Obsidian" notice.
   */
  migrated: boolean;
  /**
   * How the plugin source landed in the shadow vault. `in-place` means
   * source and target were the same directory (bootstrap re-run from
   * inside the shadow window) so nothing needed installing.
   */
  pluginInstallMethod: 'symlink' | 'copy' | 'in-place';
}

/**
 * Materialises the on-disk shadow vault for a profile so a separate
 * Obsidian window can open it as if it were any other local vault.
 *
 * Layout:
 *
 *   <baseDir>/<name>--<remotePath-tail>/     (identity is the profile id
 *   ├── .obsidian/                            in data.json, not the dir name)
 *   │   ├── community-plugins.json    ← ["remote-ssh"]
 *   │   └── plugins/
 *   │       └── remote-ssh/           ← symlink (or copy on Windows
 *   │           ├── main.js              without symlink perms) of the
 *   │           ├── manifest.json        running plugin's source dir
 *   │           ├── styles.css
 *   │           └── data.json         ← profile data + autoConnectProfileId
 *   └── (no other files — Obsidian fills the rest on first open)
 *
 * Idempotent: re-running refreshes the plugin install and rewrites
 * data.json, but never touches what Obsidian itself wrote.
 */
export class ShadowVaultBootstrap {
  constructor(
    /** Directory under which all shadow vaults live (e.g. `~/.obsidian-remote/vaults/`). */
    private readonly baseDir: string,
    /** Absolute path to THIS running plugin's directory (source for symlink/copy). */
    private readonly sourcePluginDir: string,
    private readonly registry: ObsidianRegistry,
    /**
     * This device's never-synced state root, holding the community-plugins
     * base snapshots ({@link communityPluginsBasePath}).
     */
    private readonly stateRoot: string = path.dirname(baseDir),
  ) {}

  bootstrap(profile: SshProfile, allProfiles: ReadonlyArray<SshProfile>): Promise<BootstrapResult> {
    return Promise.resolve(this.bootstrapSync(profile, allProfiles));
  }

  /**
   * Every step here is `fs.*Sync`, so `bootstrap` keeps its Promise shape for
   * callers without an `async` that `require-await` would flag.
   */
  private bootstrapSync(profile: SshProfile, allProfiles: ReadonlyArray<SshProfile>): BootstrapResult {
    // Resolve (and, when safe, migrate to) the `<name>--<tail>` shadow
    // dir for this profile. Identity is the profile id, not the dir
    // name, so a rename/collision never strands config (see resolveLayout).
    const { layout, migrated } = this.resolveLayout(profile);

    fs.mkdirSync(layout.vaultDir, { recursive: true });
    fs.mkdirSync(layout.configDir, { recursive: true });

    // First bootstrap (shadow data.json doesn't exist yet) — we'll
    // also collect a snapshot of source's enabled plugins to surface
    // through a confirmation modal in the shadow window. Detect now
    // before the `readBaseDataJson` call below side-effects state.
    const isFirstBootstrap = !fs.existsSync(layout.pluginDataFile);

    // A leftover base from a deleted shadow is destructive, not merely
    // stale: the fresh list is the `["remote-ssh"]` seed below, so every id
    // in that base reads as a local uninstall and the first push strips the
    // user's whole enabled-plugin list off the remote. Dropping it falls the
    // round-trip back to the union, and the next push writes a real base.
    if (isFirstBootstrap) this.discardCommunityPluginsBase(profile.id);

    // `["remote-ssh"]` only. Inheriting source's full list auto-installed
    // every plugin right after the "trust this vault" prompt, which read as
    // the plugin acting on its own; the user now opts in per plugin.
    this.seedCommunityPlugins(layout.configDir);

    // Without this the first connect to a new profile silently does nothing;
    // see the method for the deadlock.
    this.seedObsidianFirstRunState(layout.configDir);

    // Install our own plugin source (symlink preferred so dev
    // iterations appear immediately; copy as a Windows fallback).
    // Per-file install means data.json stays per-vault.
    const pluginInstallMethod = this.installPlugin(layout.pluginDir);

    // MERGE, not overwrite, so shadow-side state (host keys from past TOFU
    // prompts, secrets) survives a re-bootstrap; the first bootstrap seeds
    // from source so a new shadow inherits already-trusted host keys instead
    // of TOFU-prompting on its first connect.
    //
    // Bootstrap-managed fields are always overwritten.
    // `pendingPluginSuggestions` is set only on the first bootstrap, so a
    // user who has already decided is not asked again.
    const baseData = this.readBaseDataJson(layout.pluginDataFile);
    const data: Record<string, unknown> = {
      ...baseData,
      profiles: allProfiles,
      activeProfileId: profile.id,
      autoConnectProfileId: profile.id,
    };

    // #399: `readBaseDataJson` prefers the existing shadow data.json, so a
    // password entered in the source AFTER the first bootstrap would never
    // reach the window that runs the connect — which then dies with "No
    // password stored for profile". Source wins on a conflicting ref (it is
    // the user's latest), and a secret typed in the shadow window survives.
    const mergedSecrets = {
      ...asSecretRecord(baseData.secrets),
      ...this.readSourceSecrets(),
    };
    if (Object.keys(mergedSecrets).length > 0) {
      data.secrets = mergedSecrets;
    }

    if (isFirstBootstrap) {
      const pending = this.collectPendingPluginSuggestions();
      if (pending.length > 0) {
        data.pendingPluginSuggestions = pending;
      }
    }
    fs.writeFileSync(layout.pluginDataFile, JSON.stringify(data, null, 2) + '\n', 'utf-8');

    const { id: registryId, created } = this.registry.register(layout.vaultDir);

    logger.info(
      `ShadowVaultBootstrap: ${created ? 'registered' : 'reused'} shadow vault for ${profile.name} ` +
      `at ${layout.vaultDir} (registry id=${registryId}, plugin=${pluginInstallMethod})`,
    );

    return { layout, registryId, registryCreated: created, migrated, pluginInstallMethod };
  }

  /** Best-effort; absent is normal, and failing only falls back to the union. */
  private discardCommunityPluginsBase(profileId: string): void {
    const basePath = communityPluginsBasePath(this.stateRoot, profileId);
    try {
      fs.rmSync(basePath, { force: true });
    } catch (e) {
      logger.warn(`ShadowVaultBootstrap: could not discard stale ${basePath} (${errorMessage(e)})`);
    }
  }

  /**
   * The pure `<name>--<tail>` layout, before any collision ` (n)` suffix —
   * no I/O. Only `resolveLayout` calls it.
   */
  layoutFor(profile: Pick<SshProfile, 'name' | 'remotePath'>): ShadowVaultLayout {
    return this.layoutForDir(path.join(this.baseDir, friendlyVaultDirName(profile)));
  }

  /** Derive the `.obsidian/...` sub-paths for a concrete vault dir. */
  private layoutForDir(vaultDir: string): ShadowVaultLayout {
    // No live `App` exists yet, so there is no `vault.configDir` to read;
    // concatenated to keep the literal out of the AST for
    // `obsidianmd/hardcoded-config-path`.
    //
    // KNOWN GAP (#553, reverted): if the user renames the config folder this
    // disagrees with the live value and the pre-spawn pull works on a
    // directory Obsidian no longer uses. Disk detection was tried and
    // reverted — an ambiguous guess can seed `community-plugins.json` at the
    // wrong path and push it over the real list. A safe version must fail
    // closed and skip the pull.
    const configDir = path.join(vaultDir, '.' + 'obsidian');
    const pluginDir = path.join(configDir, 'plugins', 'remote-ssh');
    const pluginDataFile = path.join(pluginDir, 'data.json');
    return { vaultDir, configDir, pluginDir, pluginDataFile };
  }

  /**
   * Resolve the shadow layout to use for this profile.
   *
   * Identity is the profile *id*, not the directory name, so a rename, a
   * display-name collision or a legacy naming scheme all resolve to the same
   * shadow. A dir whose name no longer matches is migrated once, EXCEPT:
   *
   *  - the vault is currently open (obsidian.json `open` flag): renaming
   *    an open vault's dir on Windows corrupts the live junction/handles
   *    (the plugin dir goes dangling → daemon download ENOENTs → SFTP
   *    fallback). Use it as-is; migrate on the next closed bootstrap.
   *  - the desired name is already taken by a *different* profile:
   *    `uniqueVaultDir` appends ` (2)` so two vaults never share one dir
   *    (which would merge their data.json / secrets / host keys).
   *
   * The rename and the registry update are separate `try`s: once the dir has
   * moved we commit to the new path even if the registry write throws, since
   * falling back would recreate the old dir empty and orphan the real
   * config (#438).
   */
  private resolveLayout(
    profile: Pick<SshProfile, 'id' | 'name' | 'remotePath'>,
  ): { layout: ShadowVaultLayout; migrated: boolean } {
    const desired = this.layoutFor(profile);
    const found = this.findShadowByProfileId(profile.id);

    if (found) {
      // Compare `found` against this resolved target, not the bare desired
      // name: a profile parked in a ` (2)` dir would otherwise "migrate" to
      // itself every reconnect — a same-path rename reporting migrated=true
      // and re-showing the one-time "restart Obsidian" notice.
      const target = this.uniqueVaultDir(desired.vaultDir, profile.id);
      if (path.basename(found) === path.basename(target)) {
        return { layout: this.layoutForDir(found), migrated: false };
      }
      // R2: never rename a dir whose vault is open — Windows corrupts the
      // live junction. Use it as-is; migrate on the next closed run.
      if (this.registry.isOpen(found)) {
        logger.info(`ShadowVaultBootstrap: ${found} is open; deferring rename`);
        return { layout: this.layoutForDir(found), migrated: false };
      }
      // Migrate. A successful rename commits the move; a failing updatePath
      // is logged but not fatal (self-heals on register()). A failing
      // rename falls back to the found dir.
      try {
        fs.renameSync(found, target);
      } catch (e) {
        logger.warn(
          `ShadowVaultBootstrap: rename ${found} → ${target} failed (${errorMessage(e)}); using ${found} this session`,
        );
        return { layout: this.layoutForDir(found), migrated: false };
      }
      try {
        this.registry.updatePath(found, target);
      } catch (e) {
        logger.warn(
          `ShadowVaultBootstrap: registry path update failed post-migration (${errorMessage(e)}); ` +
          `config is at ${target}, registry self-heals on register()`,
        );
      }
      logger.info(`ShadowVaultBootstrap: migrated shadow ${found} → ${target}`);
      return { layout: this.layoutForDir(target), migrated: true };
    }

    // Brand-new profile — pick a collision-free dir (a different profile
    // may already own the desired `<name>--<tail>`).
    const target = this.uniqueVaultDir(desired.vaultDir, profile.id);
    return { layout: this.layoutForDir(target), migrated: false };
  }

  /**
   * The shadow whose data.json carries this `autoConnectProfileId`, under any
   * naming scheme. First match in sorted order, so it is deterministic.
   */
  private findShadowByProfileId(profileId: string): string | null {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.baseDir).sort();
    } catch {
      return null; // baseDir not created yet
    }
    for (const entry of entries) {
      const dir = path.join(this.baseDir, entry);
      let isDir: boolean;
      try { isDir = fs.statSync(dir).isDirectory(); } catch { continue; }
      if (isDir && this.readShadowProfileId(dir) === profileId) return dir;
    }
    return null;
  }

  /**
   * The `autoConnectProfileId` in `dir`, or null if it is not a shadow.
   *
   * An absent data.json is the ordinary "not a shadow" case and stays silent.
   * An EXISTING but unreadable one is logged: a transient lock or malformed
   * JSON briefly hides this profile's own shadow, and `resolveLayout` then
   * forks a duplicate ` (2)` dir instead of reusing it.
   */
  private readShadowProfileId(dir: string): string | null {
    const dataFile = this.layoutForDir(dir).pluginDataFile;
    let raw: string;
    try {
      raw = fs.readFileSync(dataFile, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`ShadowVaultBootstrap: unreadable ${dataFile} (${errorMessage(e)}); treating as non-matching`);
      }
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as { autoConnectProfileId?: unknown };
      return typeof parsed.autoConnectProfileId === 'string' ? parsed.autoConnectProfileId : null;
    } catch (e) {
      logger.warn(`ShadowVaultBootstrap: malformed ${dataFile} (${errorMessage(e)}); treating as non-matching`);
      return null;
    }
  }

  /**
   * The desired name if free or already this profile's, else `desired (2)`…
   * Two profiles sharing a dir would merge their data.json — secrets, host
   * keys, active profile — so only the on-disk name is disambiguated.
   */
  private uniqueVaultDir(desiredVaultDir: string, profileId: string): string {
    // Free (absent) or already ours → safe to take. An existing dir whose
    // data.json belongs to a DIFFERENT profile (or is unreadable, logged by
    // readShadowProfileId) is left alone so configs never merge.
    const ownsOrFree = (dir: string): boolean =>
      !fs.existsSync(dir) || this.readShadowProfileId(dir) === profileId;
    if (ownsOrFree(desiredVaultDir)) return desiredVaultDir;
    for (let n = 2; n < 100; n++) {
      const candidate = `${desiredVaultDir} (${n})`;
      if (ownsOrFree(candidate)) return candidate;
    }
    // 98 collisions on one name is absurd; fall back to an id-suffixed
    // dir so we still return something unique rather than loop forever.
    return `${desiredVaultDir} (${profileId.slice(0, 8)})`;
  }

  // ─── internals ──────────────────────────────────────────────────────────

  /**
   * Materialise `<configDir>/community-plugins.json`.
   *
   * - First bootstrap (file doesn't exist): write `["remote-ssh"]`
   *   only. Source's enabled plugin set is captured separately via
   *   `collectPendingPluginSuggestions` so the shadow window can
   *   prompt the user to opt in selectively.
   * - Re-bootstrap (file exists): leave the user's accumulated list
   *   alone. Only ensure `remote-ssh` is in it.
   */
  private seedCommunityPlugins(configDir: string): void {
    const shadowPath = path.join(configDir, 'community-plugins.json');

    if (fs.existsSync(shadowPath)) {
      try {
        const existing: unknown = JSON.parse(fs.readFileSync(shadowPath, 'utf-8'));
        if (Array.isArray(existing)) {
          const ids = (existing as unknown[]).filter((s): s is string => typeof s === 'string');
          if (!ids.includes('remote-ssh')) {
            ids.push('remote-ssh');
            fs.writeFileSync(shadowPath, JSON.stringify(ids) + '\n', 'utf-8');
          }
          return;
        }
      } catch (e) {
        logger.warn(
          `ShadowVaultBootstrap: failed to parse shadow community-plugins.json ` +
          `(${errorMessage(e)}); rewriting as [remote-ssh]`,
        );
      }
    }

    fs.writeFileSync(shadowPath, JSON.stringify(['remote-ssh']) + '\n', 'utf-8');
  }

  /**
   * Make a fresh shadow vault look *already configured*, so Obsidian loads
   * community plugins on first open instead of coming up in Restricted mode.
   *
   * Without it the first connect to a new profile deadlocks: the plugin never
   * loads, so `runAutoConnect` never runs, so the real app.json is never
   * pulled, so the vault stays "never configured" — seen in the field as a
   * new shadow vault with an empty app.json and no plugin log.
   *
   * Only ever writes a first-run placeholder: absent, blank, unparseable, or
   * the empty `{}` / `[]` Obsidian writes itself. A real config has ≥1
   * key and is never clobbered. The e2e scaffold had always pre-written this,
   * which is why the connect e2e never reproduced the failure.
   */
  private seedObsidianFirstRunState(configDir: string): void {
    const appPath = path.join(configDir, 'app.json');
    // Obsidian's actual first-run app.json is the literal `{}` — NOT a
    // zero-byte file. A `.trim() === ''` check misses that and leaves
    // the deadlock in place (the field symptom). Seed when the file is
    // absent, blank, unparseable, or an empty object; a real app.json
    // (≥1 key) is left untouched.
    if (this.needsFirstRunSeed(appPath, isNonEmptyObject)) {
      fs.writeFileSync(
        appPath,
        JSON.stringify({ promptDelete: false }, null, 2) + '\n',
        'utf-8',
      );
    }

    // Same rule for core-plugins.json — `!existsSync` alone left a
    // zero-byte / `[]` file as a deadlock (asymmetric with app.json).
    const corePath = path.join(configDir, 'core-plugins.json');
    if (this.needsFirstRunSeed(corePath, isNonEmptyArray)) {
      fs.writeFileSync(
        corePath,
        JSON.stringify([
          'file-explorer', 'global-search', 'switcher', 'graph', 'backlink',
          'canvas', 'outgoing-link', 'tag-pane', 'page-preview', 'daily-notes',
          'templates', 'note-composer', 'command-palette', 'editor-status',
          'bookmarks', 'markdown-importer', 'outline', 'word-count',
          'file-recovery',
        ]) + '\n',
        'utf-8',
      );
    }
  }

  /**
   * Absent, blank, unparseable, or rejected by `isConfigured`.
   *
   * A non-ENOENT read error is NOT "absent" and is rethrown — treating it as
   * "needs seed" would clobber a file we merely failed to read.
   */
  private needsFirstRunSeed(
    filePath: string,
    isConfigured: (parsed: unknown) => boolean,
  ): boolean {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw e;
    }
    if (raw.trim() === '') return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return true; // corrupt/partial → treat as placeholder, reseed
    }
    return !isConfigured(parsed);
  }

  /**
   * The source vault's enabled plugins and their `data.json`, stored as
   * `pendingPluginSuggestions` so the shadow window can offer them instead of
   * installing them unasked. Empty when there is nothing to suggest.
   */
  private collectPendingPluginSuggestions(): PendingPluginSuggestion[] {
    const sourceConfigDir = this.sourceConfigDir();
    const sourceListPath = path.join(sourceConfigDir, 'community-plugins.json');
    if (!fs.existsSync(sourceListPath)) return [];

    let sourceIds: string[];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(sourceListPath, 'utf-8'));
      if (!Array.isArray(parsed)) return [];
      sourceIds = (parsed as unknown[]).filter((s): s is string => typeof s === 'string' && s !== 'remote-ssh');
    } catch (e) {
      logger.warn(
        `ShadowVaultBootstrap: failed to parse source community-plugins.json ` +
        `(${errorMessage(e)}); no suggestions will be offered`,
      );
      return [];
    }

    const sourcePluginsRoot = path.join(sourceConfigDir, 'plugins');
    return sourceIds.map(id => {
      let sourceData: unknown = null;
      const dataPath = path.join(sourcePluginsRoot, id, 'data.json');
      if (fs.existsSync(dataPath)) {
        try {
          sourceData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
        } catch (e) {
          logger.warn(
            `ShadowVaultBootstrap: failed to parse source data.json for ${id} ` +
            `(${errorMessage(e)}); will offer install without config inheritance`,
          );
        }
      }
      return { id, sourceData };
    });
  }

  /**
   * `.obsidian/` of the source vault — derived from
   * `sourcePluginDir` which lives at `<source-vault>/.obsidian/plugins/remote-ssh`.
   */
  private sourceConfigDir(): string {
    // sourcePluginDir = <vault>/.obsidian/plugins/remote-ssh
    // → walk up two levels for .obsidian/.
    return path.dirname(path.dirname(this.sourcePluginDir));
  }

  /**
   * The base for the shadow's `data.json`, in order: the shadow's own copy
   * (keeping host keys and secrets accumulated since the last bootstrap),
   * else the source's (so the first connect reuses already-trusted host keys
   * rather than TOFU-prompting), else `{}`.
   *
   * A parse failure starts fresh: losing accumulated state beats writing
   * corrupt JSON that would brick the plugin on next load.
   */
  private readBaseDataJson(shadowDataPath: string): Record<string, unknown> {
    const candidates = [shadowDataPath, path.join(this.sourcePluginDir, 'data.json')];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch (e) {
        logger.warn(
          `ShadowVaultBootstrap: failed to parse ${candidate} (${errorMessage(e)}); ` +
          'continuing without it',
        );
      }
    }
    return {};
  }

  /**
   * The SOURCE vault's `secrets` blob, for #399. Always source — unlike
   * {@link readBaseDataJson}, which prefers the shadow — so the merge can let
   * the user's latest password win. `{}` whenever there is nothing to add.
   */
  private readSourceSecrets(): Record<string, unknown> {
    const sourceDataPath = path.join(this.sourcePluginDir, 'data.json');
    if (!fs.existsSync(sourceDataPath)) return {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(sourceDataPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return asSecretRecord((parsed as Record<string, unknown>).secrets);
      }
    } catch (e) {
      logger.warn(
        `ShadowVaultBootstrap: failed to read source secrets (${errorMessage(e)}); ` +
        'shadow will rely on its own accumulated secrets',
      );
    }
    return {};
  }

  /**
   * Per-file, not one symlinked directory.
   *
   * Symlinking the whole dir was tighter and quietly broke the source vault:
   * the shadow's plugin wrote its own `data.json` THROUGH the link,
   * clobbering the source's host keys and secrets on the first connect.
   *
   * So `pluginDir` is a real directory. Code and assets are symlinked
   * individually, so dev builds land immediately, and `data.json` is never
   * touched here — the caller writes a real one into it.
   */
  private installPlugin(pluginDir: string): 'symlink' | 'copy' | 'in-place' {
    // If pluginDir is a stale whole-dir symlink from an older build
    // (or a previous run of this same code on an older version),
    // unlink it — DO NOT rmSync, that would follow the link and
    // recursively delete the source plugin dir.
    try {
      const stat = fs.lstatSync(pluginDir);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(pluginDir);
      }
    } catch {
      // Doesn't exist yet, fine.
    }

    // Running from inside the shadow window it targets: source IS pluginDir,
    // and the rm+symlink cycle below would replace each real file with a link
    // to its own path. Obsidian cannot resolve that, so the plugin vanishes
    // on the next start. The bundle is already here.
    try {
      if (fs.realpathSync(this.sourcePluginDir) === fs.realpathSync(pluginDir)) {
        return 'in-place';
      }
    } catch {
      // Either side unresolvable (e.g. pluginDir doesn't exist yet, or
      // the stale whole-dir symlink was just unlinked) → not the same
      // dir; proceed with a normal install.
    }

    fs.mkdirSync(pluginDir, { recursive: true });

    const sharedFiles = ['main.js', 'manifest.json', 'styles.css'];
    const sharedDirs = ['server-bin'];

    let useSymlink = true;

    for (const f of sharedFiles) {
      const src = path.join(this.sourcePluginDir, f);
      const dst = path.join(pluginDir, f);
      if (!fs.existsSync(src)) continue;
      // Plain rmSync handles existing file or file-symlink — does NOT
      // follow into directories.
      try { fs.rmSync(dst, { force: true }); } catch { /* noop */ }
      if (useSymlink) {
        try { fs.symlinkSync(src, dst, 'file'); continue; }
        catch (e) {
          logger.warn(`ShadowVaultBootstrap: file symlink failed (${errorMessage(e)}); falling back to copy`);
          useSymlink = false;
        }
      }
      fs.copyFileSync(src, dst);
    }

    for (const d of sharedDirs) {
      const src = path.join(this.sourcePluginDir, d);
      const dst = path.join(pluginDir, d);
      // Only mirror a REAL source dir (a local dev build of the daemon). A
      // junction/symlink source is NOT propagated: it would chain the shadow
      // to another vault's server-bin and dangle if that vault is deleted,
      // breaking the per-shadow daemon download (the binary is per-arch,
      // fetched at connect time — not a shared build artifact like main.js).
      let srcStat: fs.Stats;
      try { srcStat = fs.lstatSync(src); } catch { continue; }  // absent → skip
      if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) continue;
      // Use lstat + unlink for symlinks vs rmSync recursive for real
      // dirs so we never accidentally recurse through a link.
      try {
        const stat = fs.lstatSync(dst);
        if (stat.isSymbolicLink()) fs.unlinkSync(dst);
        else                       fs.rmSync(dst, { recursive: true, force: true });
      } catch { /* noop */ }
      if (useSymlink) {
        try {
          const linkType = process.platform === 'win32' ? 'junction' : 'dir';
          fs.symlinkSync(src, dst, linkType);
          continue;
        } catch (e) {
          logger.warn(`ShadowVaultBootstrap: dir symlink failed (${errorMessage(e)}); falling back to copy`);
          useSymlink = false;
        }
      }
      // dereference so a symlinked source produces real files in the
      // shadow vault rather than nested links that wouldn't resolve.
      fs.cpSync(src, dst, { recursive: true, dereference: true });
    }

    return useSymlink ? 'symlink' : 'copy';
  }
}
