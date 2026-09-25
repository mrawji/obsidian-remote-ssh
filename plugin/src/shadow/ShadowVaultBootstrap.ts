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

/**
 * Narrow an unknown `secrets` (or `hostKeyStore`) blob to a plain
 * string-keyed record, defaulting to `{}` for anything that isn't a
 * non-array object. Keeps the #399 secret-merge below total even when a
 * data.json holds a malformed `secrets` value.
 */
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
   * True if an existing shadow dir (located by profile id, under any
   * prior naming scheme) was renamed to the current `<name>--<tail>` on
   * this bootstrap. Like a newly-registered vault, the renamed path isn't
   * in the running Obsidian's cached vault list, so the connect flow
   * surfaces the one-time "restart Obsidian" notice.
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
 * Idempotent: re-running for the same profile refreshes the plugin
 * install (so dev iterations land immediately) and rewrites data.json
 * but never touches files Obsidian itself created (workspace.json,
 * app.json, etc.).
 */
export class ShadowVaultBootstrap {
  constructor(
    /** Directory under which all shadow vaults live (e.g. `~/.obsidian-remote/vaults/`). */
    private readonly baseDir: string,
    /** Absolute path to THIS running plugin's directory (source for symlink/copy). */
    private readonly sourcePluginDir: string,
    private readonly registry: ObsidianRegistry,
    /**
     * Root of this device's never-synced sync state (e.g.
     * `~/.obsidian-remote/`), parent of the `state/` dir that holds the
     * community-plugins base snapshots — see
     * {@link ShadowVaultBootstrap.communityPluginsBasePath}. Defaults to
     * `baseDir`'s parent, which is exactly that on every real call site.
     */
    private readonly stateRoot: string = path.dirname(baseDir),
  ) {}

  bootstrap(profile: SshProfile, allProfiles: ReadonlyArray<SshProfile>): Promise<BootstrapResult> {
    return Promise.resolve(this.bootstrapSync(profile, allProfiles));
  }

  /**
   * Synchronous body of `bootstrap`. Kept private so the public
   * `bootstrap` keeps its `Promise<BootstrapResult>` shape (callers
   * already `await` it) without needing an `async` keyword that
   * `@typescript-eslint/require-await` would flag — every step here
   * is `fs.*Sync` and JSON arithmetic, no I/O actually awaits.
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

    // A first bootstrap means this device has no shadow vault for the
    // profile — either it never had one, or the user deleted it (the
    // documented recovery step). Either way any base snapshot left over
    // from a previous incarnation is STALE, and keeping it would be
    // actively destructive: the fresh shadow's list is the `["remote-ssh"]`
    // seed below, so every id in that old base would look like a local
    // uninstall and the first push would strip the user's whole
    // enabled-plugin list off the remote. Drop it — the round-trip then
    // falls back to the union (nothing lost) and re-establishes a base on
    // the first successful push.
    if (isFirstBootstrap) this.discardCommunityPluginsBase(profile.id);

    // `community-plugins.json` always starts as `["remote-ssh"]` only.
    // Inheriting source's full enabled list at bootstrap time was too
    // surprising — the shadow window would auto-install every plugin
    // from the marketplace right after Obsidian's "trust this vault"
    // prompt, which felt like the plugin was acting on its own. Now
    // the user opts in via a modal (see `pendingPluginSuggestions`
    // below) and the install only happens for what they tick.
    this.seedCommunityPlugins(layout.configDir);

    // Without this, a freshly-bootstrapped shadow vault has an empty
    // app.json → Obsidian treats it as "never configured", opens it
    // in first-run / Restricted mode, and never loads remote-ssh — so
    // runAutoConnect (and the pullSharedObsidianConfig that would
    // populate the real app.json) never run. Deadlock: the very first
    // connect to any new profile silently does nothing.
    this.seedObsidianFirstRunState(layout.configDir);

    // Install our own plugin source (symlink preferred so dev
    // iterations appear immediately; copy as a Windows fallback).
    // Per-file install means data.json stays per-vault.
    const pluginInstallMethod = this.installPlugin(layout.pluginDir);

    // data.json strategy: MERGE rather than overwrite, so accumulated
    // state on the shadow side (hostKeyStore from past TOFU prompts,
    // secrets, etc.) survives a re-bootstrap. On first bootstrap we
    // seed from the source vault's data.json so the shadow inherits
    // the source's already-trusted host keys — without that, every
    // freshly-bootstrapped shadow vault would TOFU-prompt on the
    // very first auto-connect.
    //
    // Bootstrap-managed fields (profiles list, activeProfileId,
    // autoConnectProfileId) are always overwritten to reflect the
    // current Connect click. `pendingPluginSuggestions` is set only
    // on first bootstrap (and only if source has community plugins
    // worth suggesting) so re-bootstrap doesn't re-prompt a user
    // who's already made their decision.
    const baseData = this.readBaseDataJson(layout.pluginDataFile);
    const data: Record<string, unknown> = {
      ...baseData,
      profiles: allProfiles,
      activeProfileId: profile.id,
      autoConnectProfileId: profile.id,
    };

    // #399: a password entered in the SOURCE (local) vault must reach
    // the shadow vault that actually runs the connect. `readBaseDataJson`
    // prefers the EXISTING shadow data.json, so a secret persisted to
    // source AFTER the first bootstrap would otherwise never propagate —
    // the shadow's auto-connect then dies with "No password stored for
    // profile" and the vault opens empty. Union the source's secrets
    // over whatever the shadow has accumulated: source wins on a
    // conflicting ref (it's the user's latest, just flushed by
    // openShadowVaultFor before this bootstrap), while a secret typed
    // directly in the shadow window (a ref absent from source) survives.
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

  /**
   * Delete this device's community-plugins base snapshot for `profileId`
   * (see the call site in `bootstrapSync`). Best-effort — an absent file
   * is the normal case, and a failure only means the next round-trip
   * falls back to the union.
   */
  private discardCommunityPluginsBase(profileId: string): void {
    const basePath = communityPluginsBasePath(this.stateRoot, profileId);
    try {
      fs.rmSync(basePath, { force: true });
    } catch (e) {
      logger.warn(`ShadowVaultBootstrap: could not discard stale ${basePath} (${errorMessage(e)})`);
    }
  }

  /**
   * Compute the shadow paths for a profile without doing any I/O: the
   * pure `<name>--<tail>` layout, before any collision ` (n)` suffix
   * (which only resolveLayout applies). A thin, side-effect-free path
   * builder — resolveLayout is the sole caller.
   */
  layoutFor(profile: Pick<SshProfile, 'name' | 'remotePath'>): ShadowVaultLayout {
    return this.layoutForDir(path.join(this.baseDir, friendlyVaultDirName(profile)));
  }

  /** Derive the `.obsidian/...` sub-paths for a concrete vault dir. */
  private layoutForDir(vaultDir: string): ShadowVaultLayout {
    // The shadow vault is freshly created on disk by us before Obsidian
    // ever opens it; there's no live `App` instance whose
    // `vault.configDir` we could query, so we build the directory name
    // (`.obsidian`) via concatenation. That stays out of the AST as a
    // single string literal, which keeps
    // `obsidianmd/hardcoded-config-path` happy. Once the shadow window
    // opens and the user customises `configDir`, subsequent reads use
    // `app.vault.configDir` like the rest of the plugin.
    //
    // KNOWN GAP (#553, reverted): a user who renames the config folder
    // makes this disagree with the live value, so the pre-spawn pull
    // reads and writes a directory Obsidian no longer uses. Detecting it
    // from disk was tried and reverted — an ambiguous detection can seed a
    // fresh `community-plugins.json` at the wrong path and push it over
    // the user's real list. A safe version needs the detection to fail
    // closed (skip the pre-spawn pull) rather than guess.
    const configDir = path.join(vaultDir, '.' + 'obsidian');
    const pluginDir = path.join(configDir, 'plugins', 'remote-ssh');
    const pluginDataFile = path.join(pluginDir, 'data.json');
    return { vaultDir, configDir, pluginDir, pluginDataFile };
  }

  /**
   * Resolve the shadow layout to use for this profile.
   *
   * Identity is the profile *id* (persisted as `autoConnectProfileId`
   * in the shadow's data.json), NOT the directory name — so a profile
   * rename, a display-name collision, or an older `<uuid>` / `--<id8>`
   * naming scheme all still resolve to the same shadow via
   * `findShadowByProfileId`. When the existing shadow's dir name no
   * longer matches the desired `<name>--<tail>`, we migrate it once by
   * renaming, EXCEPT:
   *
   *  - the vault is currently open (obsidian.json `open` flag): renaming
   *    an open vault's dir on Windows corrupts the live junction/handles
   *    (the plugin dir goes dangling → daemon download ENOENTs → SFTP
   *    fallback). Use it as-is; migrate on the next closed bootstrap.
   *  - the desired name is already taken by a *different* profile:
   *    `uniqueVaultDir` appends ` (2)` so two vaults never share one dir
   *    (which would merge their data.json / secrets / host keys).
   *
   * The rename and the obsidian.json path update are separate `try`s:
   * once the dir physically moves we commit to the new path even if
   * updating the registry throws, because falling back would recreate
   * the old dir empty and orphan the real config (#438 review).
   */
  private resolveLayout(
    profile: Pick<SshProfile, 'id' | 'name' | 'remotePath'>,
  ): { layout: ShadowVaultLayout; migrated: boolean } {
    const desired = this.layoutFor(profile);
    const found = this.findShadowByProfileId(profile.id);

    if (found) {
      // Where this profile's shadow SHOULD live (collision-safe): its own
      // dir if it already owns one, else the free `<name>--<tail>` or a
      // ` (n)` variant. Compare `found` to this resolved target — NOT to
      // the bare desired name — otherwise a profile permanently parked in a
      // ` (2)` dir (a display-name collision) would "migrate" to itself on
      // every reconnect: a no-op same-path rename that falsely reports
      // migrated=true and re-shows the one-time "restart Obsidian" notice.
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
   * Scan `baseDir` for the shadow whose data.json `autoConnectProfileId`
   * matches. Identity is the id, not the dir name, so this is naming-scheme
   * agnostic — it reuses the existing config whether the dir is a legacy
   * `<uuid>`, an older `<name>--<id8>`, or the current `<name>--<tail>`,
   * instead of stranding it. Returns the first match in sorted order
   * (deterministic) or null.
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
   * The `autoConnectProfileId` recorded in `dir`'s shadow data.json, or
   * null if `dir` isn't a bootstrapped shadow. A genuinely absent data.json
   * (ENOENT) is the normal "not a shadow dir" case and stays silent; an
   * EXISTING-but-unreadable data.json — a transient lock (AV / Dropbox sync
   * / a mid-write) or malformed JSON — is logged, because it can briefly
   * hide this profile's OWN shadow and make resolveLayout fork a duplicate
   * ` (2)` dir instead of reusing it. A non-string id is treated as no
   * match (only a false negative is possible, never a false reuse).
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
   * A dir the given profile may safely occupy: the desired name if it's
   * free or already this profile's, else `desired (2)`, `desired (3)`, …
   * Two profiles must never share a dir — that would merge their
   * data.json (secrets, host keys, active profile). Display-name
   * collisions are allowed; only the on-disk dir is disambiguated.
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
   * Seed the minimal `.obsidian/` state Obsidian needs to treat a
   * freshly-created shadow vault as *already configured*, so it loads
   * community plugins (incl. remote-ssh) on first open instead of
   * coming up in first-run / Restricted mode. Without this the very
   * first connect to a new profile deadlocks: the plugin never loads
   * → runAutoConnect never runs → pullSharedObsidianConfig never runs
   * → the real app.json is never pulled → the vault stays "never
   * configured" forever (observed in the field: a brand-new shadow
   * vault with an empty app.json and zero plugin log).
   *
   * Idempotent and non-destructive — only writes a file that is a
   * first-run placeholder: absent, blank, unparseable, or the literal
   * empty `{}` / `[]` Obsidian itself writes on first run. A real
   * app.json / core-plugins.json (written later by
   * pullSharedObsidianConfig, or by Obsidian once the vault has been
   * used) has ≥1 key/element and is never clobbered. The e2e scaffold
   * (`e2e/helpers/vault-scaffold.ts`) has always pre-written exactly
   * this; the production bootstrap was the one missing it — which is
   * also why the connect e2e never reproduced the failure.
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
   * True when `filePath` is a first-run placeholder that must be
   * (re)seeded: absent, blank, unparseable, or parses to a value the
   * `isConfigured` predicate rejects (e.g. `{}` / `[]`).
   *
   * A non-ENOENT read error (EACCES, EISDIR, …) is NOT "absent" — it
   * is rethrown rather than silently treated as "needs seed", which
   * would clobber a file we merely failed to read.
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
   * Snapshot the source vault's enabled community plugins (other
   * than our own `remote-ssh`) plus each one's source-side
   * `data.json`. Stored in shadow `data.json` as
   * `pendingPluginSuggestions` so the shadow window can prompt the
   * user to install only what they want — no surprise auto-install
   * after Obsidian's "trust this vault" dialog.
   *
   * Returns an empty array if source has no community-plugins.json,
   * if it has only `remote-ssh`, or if it can't be parsed.
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
   * Decide what to use as the base for the shadow vault's
   * `data.json` before merging the bootstrap-managed fields:
   *
   * - If a shadow `data.json` already exists, parse and use it.
   *   Preserves anything the shadow has accumulated since last
   *   bootstrap (hostKeyStore, secrets, user preferences).
   * - Otherwise, fall back to the source vault's `data.json` so the
   *   first shadow connect can re-use the user's already-trusted
   *   host keys instead of TOFU-prompting.
   * - Otherwise, start fresh `{}`.
   *
   * Parse failures are logged and treated as "start fresh" — better
   * to lose accumulated state than write a corrupted JSON file
   * that would brick the plugin on next load.
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
   * Read just the `secrets` blob from the SOURCE vault's data.json.
   *
   * Used to propagate a password persisted in the source (local) vault
   * into the shadow that runs the connect (#399). Unlike
   * `readBaseDataJson` — which prefers the shadow's own copy so its
   * accumulated state survives — this always reads source, so the merge
   * in `bootstrapSync` can let the source's latest secret win.
   *
   * Returns `{}` when source has no data.json, it can't be parsed, or it
   * carries no (well-formed) secrets — all benign "nothing to add" cases.
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
   * Install the plugin per-file rather than as one big symlinked
   * directory.
   *
   * The earlier "symlink the whole plugin dir" approach was tighter
   * and one fewer step, but it sneakily broke the source vault: the
   * shadow vault's plugin would write its own per-vault `data.json`
   * THROUGH the symlink, clobbering the source vault's settings
   * (hostKeyStore, secrets, …) on the very first connect.
   *
   * Fix: pluginDir is a **real directory**. Code + assets
   * (`main.js`, `manifest.json`, `styles.css`, `server-bin/`) are
   * symlinked individually so dev-build iterations land immediately,
   * but `data.json` is **never touched** by install — the caller
   * writes the per-vault data.json into pluginDir as a real file,
   * leaving the source vault's data.json untouched.
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

    // Self-install guard: when the bootstrap runs from INSIDE the
    // shadow window it targets, sourcePluginDir IS pluginDir. The
    // rm+symlink cycle below would then delete each real plugin file
    // and replace it with a symlink pointing at its own path — a
    // self-referential link Obsidian can't resolve, so the plugin
    // "disappears" on the next start. The bundle is already here;
    // there is nothing to install.
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
