import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { Notice, requestUrl } from 'obsidian';
import {
  detectRemoteTarget,
  ensureDaemonBinary as downloadDaemonBinary,
  resolveDaemonConsent,
  DaemonVerificationError,
  binaryFilename,
} from './DaemonDownloader';
import type { SftpClient } from '../ssh/SftpClient';
import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';

const DAEMON_RELEASE_REPO = 'sotashimozono/obsidian-remote-ssh';

/**
 * What acquiring a daemon binary needs from the plugin.
 *
 * Stated rather than reached for. This used to sit in `main.ts`, where the
 * only way to test it was to construct the whole plugin and overwrite its
 * private methods — and where its coverage was invisible, because `main.ts`
 * is excluded from the report.
 */
export interface DaemonBinaryHost {
  /** Where `server-bin/` lives; null when the plugin dir cannot be resolved. */
  pluginDir(): string | null;
  pluginVersion: string;
  /** Mutated in place — the cache marker is written back through it. */
  settings: {
    daemonBinaryVersion?: string;
    daemonBinarySha?: string;
    daemonDownloadConsented?: boolean;
  };
  saveSettings(): Promise<void>;
  /** One-time consent dialog for the auto-download. */
  confirmDownload(version: string): Promise<boolean>;
}

/**
 * Acquire a daemon binary for the REMOTE's os/arch when one isn't staged
 * locally. Community-store installs don't ship `server-bin/`, so we probe
 * the remote with `uname`, download the matching binary from this plugin's
 * GitHub release, and verify it against `daemon-manifest.json` (sha256)
 * before caching it under `server-bin/`. Returns `null` (→ caller
 * downgrades to SFTP) for an unsupported arch, a failed probe, a declined
 * download, or a benign download failure. A sha256/integrity failure is
 * NOT swallowed — it throws so the connect surfaces it loudly.
 */
export async function ensureDaemonBinary(
  client: Pick<SftpClient, 'exec'>,
  host: DaemonBinaryHost,
): Promise<string | null> {
  // Probe the remote os/arch. A FAILED probe (non-zero exit / SSH exec
  // error) is logged distinctly from an UNSUPPORTED arch — both stay on
  // SFTP, but conflating them hid real exec failures behind a misleading
  // "unsupported arch" message (#406 review).
  let target: Awaited<ReturnType<typeof detectRemoteTarget>>;
  try {
    target = await detectRemoteTarget(async (cmd) => {
      const r = await client.exec(cmd);
      if (r.exitCode !== 0) {
        throw new Error(`'${cmd}' exited ${r.exitCode}: ${r.stderr.trim() || '(no stderr)'}`);
      }
      return r.stdout;
    });
  } catch (e) {
    logger.warn(`ensureDaemonBinary: remote uname probe failed (${errorMessage(e)}); staying on SFTP`);
    return null;
  }
  if (!target) {
    logger.warn('ensureDaemonBinary: unsupported remote os/arch; staying on SFTP');
    return null;
  }

  const pluginDir = host.pluginDir();
  if (!pluginDir) return null;
  const cacheDir = path.join(pluginDir, 'server-bin');

  // R3: `server-bin` must be a REAL per-shadow dir. Older installs (and dev
  // symlink installs) could leave it as a junction to ANOTHER vault's
  // server-bin (installPlugin used to propagate it); if that target vault was
  // later deleted, the junction dangles and mkdir throws a raw ENOENT — the
  // connect then silently degrades to SFTP. Try a plain mkdir first (a valid
  // dir/junction is fine); on failure, unlink a stale reparse point (never
  // following into / deleting its target) and recreate a real dir. Only give
  // up to SFTP if even that fails.
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch (firstErr) {
    let repaired = false;
    try {
      // lstat succeeds for a dangling junction; unlink drops the link only.
      if (fs.lstatSync(cacheDir).isSymbolicLink()) {
        fs.unlinkSync(cacheDir);
        fs.mkdirSync(cacheDir, { recursive: true });
        repaired = true;
      }
    } catch { /* fall through to the SFTP path below */ }
    if (!repaired) {
      logger.error(
        `ensureDaemonBinary: server-bin unusable (${errorMessage(firstErr)}); staying on SFTP. ` +
        'If this persists, delete the shadow vault dir under ~/.obsidian-remote/vaults and reconnect.',
      );
      new Notice(
        'Remote SSH: the daemon cache dir is broken — staying on SFTP. If this persists, ' +
        'delete the vault dir under ~/.obsidian-remote/vaults and reconnect.',
      );
      return null;
    }
    logger.warn(`ensureDaemonBinary: repaired a stale server-bin link at ${cacheDir}`);
  }

  // Fast path: reuse the cached binary without a GitHub round-trip when it
  // was provisioned for THIS plugin version AND its bytes still hash to the
  // recorded sha. The sha re-check upholds the "never deploy an unverified
  // binary" invariant even here — a file corrupted/truncated after its
  // verified download is caught (network-free) and re-fetched below. A
  // version mismatch, missing marker, or sha mismatch falls through to the
  // manifest sha re-check / download.
  const dest = path.join(cacheDir, binaryFilename(target));
  if (
    host.settings.daemonBinaryVersion === host.pluginVersion &&
    host.settings.daemonBinarySha &&
    (await sha256File(dest)) === host.settings.daemonBinarySha
  ) {
    logger.info(`ensureDaemonBinary: cached daemon validated for ${host.pluginVersion}; reusing`);
    return dest;
  }

  // Consent gate (asked once; the decision — accept OR decline — is
  // persisted so a decline doesn't re-prompt on every connect / restart).
  const consented = await resolveDaemonConsent(
    host.settings.daemonDownloadConsented === true,
    () => host.confirmDownload(host.pluginVersion),
    async (c) => { host.settings.daemonDownloadConsented = c; await host.saveSettings(); },
  );
  if (!consented) {
    logger.info('ensureDaemonBinary: user declined daemon download; staying on SFTP');
    return null;
  }

  try {
    const local = await downloadDaemonBinary(
      {
        fetchBinary: async (url) => new Uint8Array((await requestUrl({ url })).arrayBuffer),
        fetchText: async (url) => (await requestUrl({ url })).text,
        cacheDir,
        readCached: async (abs) => {
          try { return new Uint8Array(await fs.promises.readFile(abs)); }
          catch { return null; }
        },
        writeExecutable: async (abs, bytes) => {
          // Atomic: write a temp sibling, chmod, then rename. A crash
          // mid-write can't then leave a torn binary that a later sha
          // re-check would hand back unverified (#406 review).
          await fs.promises.mkdir(path.dirname(abs), { recursive: true });
          const tmp = `${abs}.${process.pid}.tmp`;
          await fs.promises.writeFile(tmp, bytes);
          await fs.promises.chmod(tmp, 0o755);
          await fs.promises.rename(tmp, abs);
        },
        repo: DAEMON_RELEASE_REPO,
        version: host.pluginVersion,
      },
      target,
    );
    // Record the version + sha this cached binary is validated for, so the
    // next same-version connect takes the network-free fast path above.
    // Non-fatal: the binary is verified on disk, so a marker-persist failure
    // must NOT be reported as a download failure — we just re-verify on the
    // next connect.
    try {
      host.settings.daemonBinaryVersion = host.pluginVersion;
      host.settings.daemonBinarySha = (await sha256File(local)) ?? undefined;
      await host.saveSettings();
    } catch (e) {
      logger.warn(
        `ensureDaemonBinary: daemon ready but failed to persist cache marker ` +
        `(${errorMessage(e)}); will re-verify on the next connect`,
      );
    }
    new Notice(`Remote SSH: daemon ready for ${target.os}/${target.arch}.`);
    return local;
  } catch (e) {
    // A sha256 mismatch / malformed manifest (DaemonVerificationError) is a
    // tamper/integrity signal — rethrow so the connect surfaces it loudly
    // (ERROR state + classified Notice) instead of a quiet "Using SFTP".
    // Only benign failures (network / 404) downgrade silently.
    if (e instanceof DaemonVerificationError) throw e;
    logger.error(`ensureDaemonBinary: download failed: ${errorMessage(e)}`);
    new Notice(`Remote SSH: daemon download failed — ${errorMessage(e)}. Using SFTP.`);
    return null;
  }
}

/**
 * sha256 (hex) of a cached daemon binary, or null if it can't be read.
 * Used by the connect fast-path to re-validate the cached bytes without a
 * network round-trip. Reads the whole file (a daemon binary is a few MB) —
 * cheap next to the SSH connect it gates.
 */
async function sha256File(abs: string): Promise<string | null> {
  try {
    const buf = await fs.promises.readFile(abs);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}
