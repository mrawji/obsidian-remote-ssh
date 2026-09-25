import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

/**
 * `ensureDaemonBinary` moved out of `main.ts` so it could be reached without
 * constructing a plugin — and so its coverage would show up at all. It did
 * have tests; they covered the cached fast path and two declines, and left
 * the download, verify and persist paths at 40%. Those are the ones that
 * decide whether an unverified binary can reach the remote.
 */

const downloadSpy = vi.fn();
vi.mock('../src/transport/DaemonDownloader', async (orig) => {
  const real = await orig<typeof import('../src/transport/DaemonDownloader')>();
  return { ...real, ensureDaemonBinary: (...a: unknown[]) => downloadSpy(...a) };
});

import { ensureDaemonBinary, type DaemonBinaryHost } from '../src/transport/ensureDaemonBinary';
import { DaemonVerificationError } from '../src/transport/DaemonDownloader';

const BIN_NAME = 'obsidian-remote-server-linux-amd64';
/** A path that deliberately does not exist, for the dangling-link case. */
const dir0 = path.join(os.tmpdir(), `rs-daemon-absent-${process.pid}`);

/** Answers the `uname` probe as a linux/amd64 host. */
const linuxAmd64Client = {
  exec: async (cmd: string) => ({
    stdout: cmd === 'uname -s' ? 'Linux' : 'x86_64',
    stderr: '',
    exitCode: 0,
  }),
};

const tmpDirs: string[] = [];
function scratchPluginDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rs-daemon-mod-${process.pid}-`));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'server-bin'), { recursive: true });
  return dir;
}
afterEach(() => {
  downloadSpy.mockReset();
  while (tmpDirs.length) {
    try { fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeHost(
  dir: string,
  settings: Record<string, unknown>,
  over: Partial<DaemonBinaryHost> = {},
): DaemonBinaryHost {
  return {
    pluginDir: () => dir,
    pluginVersion: '1.2.0',
    settings: settings as DaemonBinaryHost['settings'],
    saveSettings: async () => { /* no-op persist */ },
    confirmDownload: async () => true,
    ...over,
  };
}

describe('ensureDaemonBinary — cached fast path', () => {
  it('reuses the cached binary WITHOUT any download when version + sha both match', async () => {
    const dir = scratchPluginDir();
    const bin = path.join(dir, 'server-bin', BIN_NAME);
    const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
    fs.writeFileSync(bin, bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');

    const result = await ensureDaemonBinary(
      linuxAmd64Client,
      makeHost(dir, { daemonBinaryVersion: '1.2.0', daemonBinarySha: sha }),
    );

    expect(result).toBe(bin);
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  it('does NOT take the fast path when the cached bytes no longer match the sha (post-write corruption)', async () => {
    const dir = scratchPluginDir();
    fs.writeFileSync(path.join(dir, 'server-bin', BIN_NAME), Buffer.from([0x00, 0x11, 0x22]));

    const result = await ensureDaemonBinary(linuxAmd64Client, makeHost(dir, {
      daemonBinaryVersion: '1.2.0',
      daemonBinarySha: 'f'.repeat(64), // deliberately wrong
      daemonDownloadConsented: false,
    }, { confirmDownload: async () => false }));

    expect(result).toBeNull(); // fell through (not reused) → declined → SFTP
  });

  it('does NOT trust a marker whose binary is gone', async () => {
    // The marker says "verified"; the file it describes was deleted. Hashing
    // it fails, which must read as "not cached" rather than as a match.
    const dir = scratchPluginDir(); // server-bin exists, binary does not

    const result = await ensureDaemonBinary(linuxAmd64Client, makeHost(dir, {
      daemonBinaryVersion: '1.2.0',
      daemonBinarySha: 'a'.repeat(64),
      daemonDownloadConsented: false,
    }, { confirmDownload: async () => false }));

    expect(result).toBeNull(); // fell through → declined → SFTP
  });

  it('does NOT take the fast path when the recorded version differs from the plugin version', async () => {
    const dir = scratchPluginDir();
    const bin = path.join(dir, 'server-bin', BIN_NAME);
    const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
    fs.writeFileSync(bin, bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');

    const result = await ensureDaemonBinary(linuxAmd64Client, makeHost(dir, {
      daemonBinaryVersion: '1.1.0',
      daemonBinarySha: sha,
      daemonDownloadConsented: false,
    }, { confirmDownload: async () => false }));

    expect(result).toBeNull(); // version mismatch → re-check path → declined → SFTP
  });
});

describe('ensureDaemonBinary — what may and may not be swallowed', () => {
  it('rethrows an integrity failure instead of quietly using SFTP', async () => {
    // The one failure that must never downgrade silently: a binary whose
    // bytes do not match the published sha is a tamper signal, and "Using
    // SFTP" would hide it behind a routine-looking notice.
    const dir = scratchPluginDir();
    downloadSpy.mockRejectedValueOnce(new DaemonVerificationError('sha256 mismatch'));

    await expect(
      ensureDaemonBinary(linuxAmd64Client, makeHost(dir, { daemonDownloadConsented: true })),
    ).rejects.toBeInstanceOf(DaemonVerificationError);
  });

  it('downgrades quietly when the download merely fails', async () => {
    // A 404 or a dead network is not a security event; the session should
    // carry on over SFTP.
    const dir = scratchPluginDir();
    downloadSpy.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'));

    const result = await ensureDaemonBinary(
      linuxAmd64Client,
      makeHost(dir, { daemonDownloadConsented: true }),
    );

    expect(result).toBeNull();
  });

  it('stays on SFTP when the remote os/arch is not one we build for', async () => {
    const dir = scratchPluginDir();
    const plan9 = { exec: async () => ({ stdout: 'Plan9', stderr: '', exitCode: 0 }) };

    expect(await ensureDaemonBinary(plan9, makeHost(dir, {}))).toBeNull();
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  it('stays on SFTP when the uname probe itself fails', async () => {
    // Distinct from an unsupported arch: conflating the two hid real exec
    // failures behind a misleading "unsupported arch" (#406).
    const dir = scratchPluginDir();
    const broken = { exec: async () => ({ stdout: '', stderr: 'permission denied', exitCode: 126 }) };

    expect(await ensureDaemonBinary(broken, makeHost(dir, {}))).toBeNull();
    expect(downloadSpy).not.toHaveBeenCalled();
  });
});

describe('ensureDaemonBinary — after a successful download', () => {
  function stageDownload(dir: string, bytes: Buffer): string {
    const abs = path.join(dir, 'server-bin', BIN_NAME);
    downloadSpy.mockImplementation(async () => { fs.writeFileSync(abs, bytes); return abs; });
    return abs;
  }

  it('records the version and sha it just verified, so the next connect skips the network', async () => {
    const dir = scratchPluginDir();
    const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x09]);
    const abs = stageDownload(dir, bytes);
    const settings: Record<string, unknown> = { daemonDownloadConsented: true };

    const result = await ensureDaemonBinary(linuxAmd64Client, makeHost(dir, settings));

    expect(result).toBe(abs);
    expect(settings.daemonBinaryVersion).toBe('1.2.0');
    expect(settings.daemonBinarySha).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('still returns the binary when the cache marker cannot be persisted', async () => {
    // The bytes are already verified on disk. Reporting a persist failure as
    // a download failure would drop a working daemon; the only cost is that
    // the next connect re-verifies.
    const dir = scratchPluginDir();
    const abs = stageDownload(dir, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));

    const result = await ensureDaemonBinary(linuxAmd64Client, makeHost(dir,
      { daemonDownloadConsented: true },
      { saveSettings: async () => { throw new Error('data.json is read-only'); } },
    ));

    expect(result).toBe(abs);
  });

  it('asks once and remembers a decline, rather than prompting every connect', async () => {
    const dir = scratchPluginDir();
    const settings: Record<string, unknown> = {};
    let asked = 0;

    const result = await ensureDaemonBinary(linuxAmd64Client, makeHost(dir, settings,
      { confirmDownload: async () => { asked++; return false; } },
    ));

    expect(result).toBeNull();
    expect(asked).toBe(1);
    expect(settings.daemonDownloadConsented).toBe(false);
  });
});

describe('ensureDaemonBinary — a broken server-bin cache dir', () => {
  /** Like scratchPluginDir, but `server-bin` is whatever the caller makes it. */
  function dirWithBrokenCache(make: (cacheDir: string) => void): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rs-daemon-bad-${process.pid}-`));
    tmpDirs.push(dir);
    make(path.join(dir, 'server-bin'));
    return dir;
  }

  it('relinks a dangling server-bin symlink rather than degrading to SFTP', async () => {
    // Dev installs used to propagate `server-bin` as a junction to ANOTHER
    // vault. Delete that vault and mkdir throws a raw ENOENT, which used to
    // read as "no daemon" and quietly drop the session to SFTP.
    const dir = dirWithBrokenCache((cacheDir) => {
      fs.symlinkSync(path.join(dir0, 'gone'), cacheDir);
    });
    const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
    const abs = path.join(dir, 'server-bin', BIN_NAME);
    downloadSpy.mockImplementation(async () => { fs.writeFileSync(abs, bytes); return abs; });

    const result = await ensureDaemonBinary(
      linuxAmd64Client,
      makeHost(dir, { daemonDownloadConsented: true }),
    );

    expect(result).toBe(abs);
    // The link was replaced by a real dir — and its target was never followed.
    expect(fs.lstatSync(path.join(dir, 'server-bin')).isDirectory()).toBe(true);
  });

  it('stays on SFTP, loudly, when server-bin cannot be made usable', async () => {
    // A plain file in the way is not a stale link, so there is nothing to
    // repair. The user is told, because the alternative is a session that
    // silently never uses the daemon.
    const dir = dirWithBrokenCache((cacheDir) => fs.writeFileSync(cacheDir, 'not a dir'));

    const result = await ensureDaemonBinary(
      linuxAmd64Client,
      makeHost(dir, { daemonDownloadConsented: true }),
    );

    expect(result).toBeNull();
    expect(downloadSpy).not.toHaveBeenCalled();
  });
});

describe('ensureDaemonBinary — how the bytes land', () => {
  it('writes through a temp sibling and renames, so a crash cannot leave a torn binary', async () => {
    // A half-written file that a later sha re-check hands back would be an
    // unverified binary deployed to the remote.
    const dir = scratchPluginDir();
    const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x11, 0x22]);
    const abs = path.join(dir, 'server-bin', BIN_NAME);
    const seenDuringWrite: string[] = [];

    downloadSpy.mockImplementation(async (deps: {
      writeExecutable: (abs: string, b: Uint8Array) => Promise<void>;
      readCached: (abs: string) => Promise<Uint8Array | null>;
    }) => {
      expect(await deps.readCached(abs)).toBeNull();   // nothing staged yet
      await deps.writeExecutable(abs, bytes);
      seenDuringWrite.push(...fs.readdirSync(path.join(dir, 'server-bin')));
      return abs;
    });

    const result = await ensureDaemonBinary(
      linuxAmd64Client,
      makeHost(dir, { daemonDownloadConsented: true }),
    );

    expect(result).toBe(abs);
    expect(fs.readFileSync(abs)).toEqual(bytes);
    // Executable, and no `.tmp` left behind.
    expect(fs.statSync(abs).mode & 0o111).toBeTruthy();
    expect(seenDuringWrite.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
