import { createHash } from 'crypto';
import type { SshProfile } from '../types';

/**
 * Turning user-supplied strings into path segments.
 *
 * Two of these reach the filesystem from `data.json`, which nothing
 * validates — a hand-edited profile name or id must not be able to escape
 * the directory it is meant to name.
 */

/**
 * Filesystem-safe form of a profile id for the per-device `state/<key>/`
 * dir. Ids are normally UUIDs (already safe), but they come from
 * data.json and are not validated anywhere, so a hand-edited id must not
 * be able to escape `state/` via `..` or a path separator.
 */
export function sanitiseStateKey(profileId: string): string {
  const id = profileId ?? '';
  const cleaned = id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  const usable = cleaned !== '' && !/^\.+$/.test(cleaned);
  // An id that needed no rewriting keys on itself — which is every normal
  // profile, since ids are UUIDs. Anything else gets a hash of the ORIGINAL
  // id appended, because the rewrite is lossy: `a/b` and `a?b` both clean to
  // `a_b`, and two profiles sharing one state dir share a merge base — which
  // is how a plugin uninstalled on one profile disappears from another.
  if (usable && cleaned === id) return cleaned;
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 16);
  return usable ? `${cleaned}-${hash}` : `id-${hash}`;
}

/**
 * Filesystem-safe form of a profile *name* for the friendly vault-dir
 * name. Obsidian shows a vault by its directory basename, so this is
 * what the user sees instead of a raw UUID. Spaces are kept (valid in
 * dir names on every OS); anything path-dangerous is collapsed to `_`;
 * length-capped; never `.`/`..`/empty.
 */
function sanitiseVaultName(name: string): string {
  const cleaned = (name ?? '')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/_{2,}/g, '_')
    .trim()
    .slice(0, 40)
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'vault';
  return cleaned;
}

/**
 * Filesystem-safe form of the remotePath's LAST segment. One host
 * (profile name) often holds several independent vaults under
 * different folders, so the folder tail is what disambiguates them —
 * `/home/souta/work` → `work`, `/home/souta/work/dev` → `dev`. Same
 * sanitising rules as the name; a bare/degenerate path falls back to
 * `vault`.
 */
function sanitisePathTail(remotePath: string): string {
  const trimmed = (remotePath ?? '').replace(/[/\\]+$/, '');
  const tail = trimmed.split(/[/\\]/).pop() ?? '';
  // A bare `~` (vault rooted at the remote home dir) has no meaningful
  // folder tail — catch it before the charset strip below turns it into `_`.
  if (tail === '~') return 'vault';
  const cleaned = tail
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/_{2,}/g, '_')
    .trim()
    .slice(0, 40)
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'vault';
  return cleaned;
}

/**
 * The shadow vault's directory name: `<friendly-name>--<path-tail>`.
 * The name identifies the host, the tail the folder — together they
 * let Obsidian show a recognisable, folder-distinct name (e.g.
 * `Panza--work` vs `Panza--dev`) instead of a bare UUID. The id is NOT
 * in the name: identity is resolved from `data.json`'s
 * `autoConnectProfileId` (see `findShadowByProfileId`), so a profile
 * rename or a display-name collision never strands its config.
 */
export function friendlyVaultDirName(profile: Pick<SshProfile, 'name' | 'remotePath'>): string {
  return `${sanitiseVaultName(profile.name)}--${sanitisePathTail(profile.remotePath)}`;
}
