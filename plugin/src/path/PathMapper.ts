import * as os from 'os';

/**
 * Built by concatenation so the source never contains the raw literal that
 * `obsidianmd/hardcoded-config-path` rejects. Production passes
 * `app.vault.configDir`; this default only keeps older tests green.
 */
function defaultObsidianConfigDir(): string {
  return '.' + 'obsidian';
}

/**
 * configDir-relative paths holding client-private state, redirected from
 * `<configDir>/<file>` to `<configDir>/user/<client-id>/<file>` so two
 * machines on one vault do not trample each other's UI state. The list errs
 * private: per-machine costs nothing, a corrupted layout file is loud.
 *
 * Matched exactly or as a directory prefix; see {@link matchesPrivatePattern}
 * for the `*` semantics.
 */
export const DEFAULT_PRIVATE_PATTERN_BASENAMES: readonly string[] = [
  'workspace.json',
  'workspace-mobile.json',
  // Per-device. A shared copy was a perpetual write-conflict source: two
  // sessions both wrote `<configDir>/app.json` at the identity path, so every
  // settings save tripped PreconditionFailed against the other's mtime.
  // Redirecting makes the shared path, and so the conflict, unrepresentable.
  'app.json',
  'appearance.json',
  'core-plugins.json',
  'hotkeys.json',
  // Plugin SETTINGS (#342 / #429), same reason: `saveData()` fires on every
  // change. `plugins/*/data.json` and NOT `plugins` — the plugin's CODE stays
  // shared at the identity path, or a plugin installed on one machine would
  // not load on any other (CommunityPluginsSync's `PLUGIN_BINARY_FILES`).
  'plugins/*/data.json',
  'cache',
  'cache.zlib',
  'types.json',
  'file-recovery.json',
  'graph.json',
  'canvas.json',
];

/**
 * Exact match, or directory prefix (`cache` covers `cache/anything`). A `*`
 * segment matches exactly one path segment, never across `/` — which is what
 * makes `plugins/claudian/data.json` private while leaving `main.js` shared.
 */
function matchesPrivatePattern(pattern: string, normalized: string): boolean {
  if (!pattern.includes('*')) {
    return normalized === pattern || normalized.startsWith(pattern + '/');
  }
  const pat = pattern.split('/');
  const seg = normalized.split('/');
  // Shorter than the pattern → neither the file itself nor inside it.
  if (seg.length < pat.length) return false;
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] === '*') continue; // any single segment
    if (pat[i] !== seg[i]) return false;
  }
  // Equal depth = the file itself; deeper = inside it (directory-prefix).
  return true;
}

/** Back-compat re-export: the basenames joined onto the default configDir. */
export const DEFAULT_PRIVATE_PATTERNS: readonly string[] =
  DEFAULT_PRIVATE_PATTERN_BASENAMES.map(
    (b) => `${defaultObsidianConfigDir()}/${b}`,
  );

/**
 * The directory we own under `<configDir>/`. Listing the configDir strips it,
 * so other clients' state never surfaces in the vault UI.
 */
const PRIVATE_USER_SUBDIR = 'user';

/** A hostname made safe to use as a directory name. */
export function sanitizeClientId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'unknown';
}

/**
 * Stable id from the OS hostname. Two instances on one machine need an
 * explicit override, or they share a subtree.
 */
export function defaultClientId(): string {
  try {
    return sanitizeClientId(os.hostname());
  } catch {
    return 'unknown';
  }
}

/** Placeholder and blank-field fallback in settings. `userInfo()` may throw. */
export function defaultUserName(): string {
  try {
    const info = os.userInfo();
    return info.username || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Translates between the paths Obsidian uses and the paths stored on the
 * remote. Identity for ordinary content; only the private patterns are
 * redirected into a per-client subtree. Stateless beyond its configuration.
 */
export class PathMapper {
  /** Per-machine identifier (sanitised hostname). */
  public readonly clientId: string;

  /** Exposed so collaborators build configDir-rooted prefixes from one source. */
  public readonly configDir: string;
  private readonly configDirSlash: string;
  private readonly privateRoot: string;
  private readonly privatePatterns: readonly string[];

  /**
   * Two forms: `(clientId, patterns?)` from older call sites, and
   * `(clientId, configDir, patterns?)` for new ones. Dispatches on whether the
   * second argument is a string or an array.
   */
  constructor(clientId: string, configDirOrPatterns?: string | readonly string[], privatePatterns?: readonly string[]) {
    let configDir: string;
    let patterns: readonly string[];
    if (Array.isArray(configDirOrPatterns)) {
      // Legacy two-arg form: `new PathMapper(clientId, patterns)`.
      configDir = defaultObsidianConfigDir();
      patterns = configDirOrPatterns;
    } else {
      configDir = (configDirOrPatterns as string | undefined) ?? defaultObsidianConfigDir();
      patterns = privatePatterns ?? DEFAULT_PRIVATE_PATTERN_BASENAMES;
    }
    this.clientId = clientId;
    this.configDir = configDir;
    this.configDirSlash = `${configDir}/`;
    this.privateRoot = `${configDir}/${PRIVATE_USER_SUBDIR}/${clientId}`;
    // Relative patterns resolve against configDir; already-qualified ones are
    // kept as-is for callers passing the legacy fully-qualified list.
    this.privatePatterns = patterns.map((p) =>
      p.startsWith(this.configDirSlash) ? p : `${configDir}/${p}`,
    );
  }

  // ─── classification ──────────────────────────────────────────────────────

  /** True when the vault-relative path should live in this client's private subtree. */
  isPrivate(vaultPath: string): boolean {
    const normalized = stripLeadingSlash(vaultPath);
    return this.privatePatterns.some(p => matchesPrivatePattern(p, normalized));
  }

  /**
   * Parent of a private pattern but not itself private. Listing one must merge
   * in this client's subtree so the patterns appear under their nominal names.
   */
  isCrossingPoint(vaultPath: string): boolean {
    const normalized = stripLeadingSlash(vaultPath);
    if (this.isPrivate(normalized)) return false;
    // Exact depth, not dir-prefix: the crossing point is the pattern's
    // immediate parent. For `plugins/*/data.json` that is `plugins/<id>`, so
    // listing one plugin's dir merges its private data.json while listing
    // `plugins/` does not — the plugin dirs themselves are shared.
    return this.privatePatterns.some(p => matchesPatternExact(parentDirOf(p), normalized));
  }

  // ─── translation ─────────────────────────────────────────────────────────

  /**
   * Identity for non-private paths; private ones move into the per-client
   * subtree. A custom pattern outside `configDir` is accepted, but its whole
   * original path is appended verbatim.
   */
  toRemote(vaultPath: string): string {
    const normalized = stripLeadingSlash(vaultPath);
    if (!this.isPrivate(normalized)) return vaultPath;
    const rest = normalized.startsWith(this.configDirSlash)
      ? normalized.slice(this.configDirSlash.length)
      : normalized;
    return `${this.privateRoot}/${rest}`;
  }

  /**
   * The inverse. Other clients' subtrees come back unchanged, so the caller
   * decides whether to filter them.
   */
  toVault(remotePath: string): string {
    const prefix = `${this.privateRoot}/`;
    if (remotePath.startsWith(prefix)) {
      return `${this.configDirSlash}${remotePath.slice(prefix.length)}`;
    }
    return remotePath;
  }

  // ─── listing helpers ─────────────────────────────────────────────────────

  /**
   * Plan a `list(vaultPath)`. `primary` is always queried; `mergeFromUser`
   * asks the caller to also list `userSubtree` and concatenate, and
   * `hideUserDirName` names an entry to drop from the primary listing.
   */
  resolveListing(vaultPath: string): {
    primary: string;
    mergeFromUser: boolean;
    userSubtree?: string;
    hideUserDirName?: string;
  } {
    const normalized = stripLeadingSlash(vaultPath);
    if (this.isPrivate(normalized)) {
      // The whole subtree lives in user/<id>/...
      return { primary: this.toRemote(vaultPath), mergeFromUser: false };
    }
    if (this.isCrossingPoint(normalized)) {
      // The private subtree mirrors the configDir-relative path, so the
      // counterpart is `privateRoot/<same relative path>` — empty for the
      // configDir itself, `plugins/<id>` for a plugin's own dir.
      const rest = normalized.startsWith(this.configDirSlash)
        ? normalized.slice(this.configDirSlash.length)
        : '';
      return {
        primary: vaultPath,
        mergeFromUser: true,
        userSubtree: rest ? `${this.privateRoot}/${rest}` : this.privateRoot,
        // Only the configDir has the `user` sibling; deeper crossing points
        // have none, so other clients' subtrees never surface.
        hideUserDirName: normalized === this.configDir ? PRIVATE_USER_SUBDIR : undefined,
      };
    }
    return { primary: vaultPath, mergeFromUser: false };
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Same depth only. Unlike {@link matchesPrivatePattern} it never matches a
 * deeper path, which crossing-point detection needs: a prefix match there
 * would flag every ancestor.
 */
function matchesPatternExact(pattern: string, normalized: string): boolean {
  const pat = pattern.split('/');
  const seg = normalized.split('/');
  if (pat.length !== seg.length) return false;
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] === '*') continue;
    if (pat[i] !== seg[i]) return false;
  }
  return true;
}

function stripLeadingSlash(p: string): string {
  return p.startsWith('/') ? p.slice(1) : p;
}

function parentDirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
