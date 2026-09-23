import { Client, type FileEntryWithStats, type SFTPWrapper } from 'ssh2';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TEST_HOST = '127.0.0.1';
const TEST_PORT = 2222;
const TEST_USER = 'tester';
const TEST_VAULT_REMOTE = `/home/${TEST_USER}/vault`;

const PRIVATE_KEY_PATH = path.resolve(
  __dirname, '..', '..', '..', 'docker', 'keys', 'id_test',
);

/**
 * Direct SSH/SFTP connection to the Docker test sshd for verifying
 * that plugin operations landed on the remote filesystem.
 *
 * This bypasses the plugin entirely — it's the "ground truth" check.
 */
export class RemoteVerifier {
  private client: Client | null = null;

  /** Try to connect. Returns false if the sshd is unreachable. */
  async connect(): Promise<boolean> {
    if (!fs.existsSync(PRIVATE_KEY_PATH)) return false;

    return new Promise<boolean>((resolve) => {
      const client = new Client();
      const timer = setTimeout(() => {
        client.destroy();
        resolve(false);
      }, 10_000);

      client.on('ready', () => {
        clearTimeout(timer);
        this.client = client;
        resolve(true);
      });

      client.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });

      client.connect({
        host: TEST_HOST,
        port: TEST_PORT,
        username: TEST_USER,
        privateKey: fs.readFileSync(PRIVATE_KEY_PATH),
      });
    });
  }

  /** Check if a file exists on the remote. */
  async exists(relativePath: string): Promise<boolean> {
    const fullPath = `${TEST_VAULT_REMOTE}/${relativePath}`;
    return new Promise((resolve) => {
      this.requireClient().sftp((err, sftp) => {
        if (err) { resolve(false); return; }
        sftp.stat(fullPath, (statErr) => {
          sftp.end();
          resolve(!statErr);
        });
      });
    });
  }

  /** Read file content from the remote. Returns null if not found. */
  async readFile(relativePath: string): Promise<string | null> {
    const fullPath = `${TEST_VAULT_REMOTE}/${relativePath}`;
    return new Promise((resolve) => {
      this.requireClient().sftp((err, sftp) => {
        if (err) { resolve(null); return; }
        sftp.readFile(fullPath, 'utf8', (readErr, data) => {
          sftp.end();
          if (readErr) { resolve(null); return; }
          resolve(typeof data === 'string' ? data : data.toString('utf8'));
        });
      });
    });
  }

  /** List files in a remote directory. */
  async listDir(relativePath: string): Promise<string[]> {
    const fullPath = `${TEST_VAULT_REMOTE}/${relativePath}`;
    return new Promise((resolve) => {
      this.requireClient().sftp((err, sftp) => {
        if (err) { resolve([]); return; }
        sftp.readdir(fullPath, (readErr, list) => {
          sftp.end();
          if (readErr) { resolve([]); return; }
          resolve(list.map((e) => e.filename).filter((n) => n !== '.' && n !== '..'));
        });
      });
    });
  }

  /** Write a file on the remote (for test setup). */
  async writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = `${TEST_VAULT_REMOTE}/${relativePath}`;
    return new Promise((resolve, reject) => {
      this.requireClient().sftp((err, sftp) => {
        if (err) { reject(err); return; }
        sftp.writeFile(fullPath, content, (writeErr) => {
          sftp.end();
          if (writeErr) reject(writeErr);
          else resolve();
        });
      });
    });
  }

  /**
   * Write binary content. Used by the large-image render scenario
   * where a Buffer payload (e.g. a 1 MB PNG) is what we need on disk.
   */
  async writeBinaryFile(relativePath: string, content: Buffer): Promise<void> {
    const fullPath = `${TEST_VAULT_REMOTE}/${relativePath}`;
    return new Promise((resolve, reject) => {
      this.requireClient().sftp((err, sftp) => {
        if (err) { reject(err); return; }
        sftp.writeFile(fullPath, content, (writeErr) => {
          sftp.end();
          if (writeErr) reject(writeErr);
          else resolve();
        });
      });
    });
  }

  /**
   * Stat a remote path. Returns mtime in milliseconds + size; null if
   * the path is missing. Used by the modify scenario to assert that
   * the daemon side actually saw a write — not just that the plugin
   * thinks it did. ssh2 returns mtime as POSIX seconds since epoch;
   * we multiply by 1000 so callers can compare against `Date.now()`.
   */
  async stat(relativePath: string): Promise<{ mtimeMs: number; size: number } | null> {
    const fullPath = `${TEST_VAULT_REMOTE}/${relativePath}`;
    return new Promise((resolve) => {
      this.requireClient().sftp((err, sftp) => {
        if (err) { resolve(null); return; }
        sftp.stat(fullPath, (statErr, attrs) => {
          sftp.end();
          if (statErr || !attrs) { resolve(null); return; }
          resolve({ mtimeMs: attrs.mtime * 1000, size: attrs.size });
        });
      });
    });
  }

  /** Atomic rename on the remote (POSIX `rename(2)`). */
  async rename(fromRelative: string, toRelative: string): Promise<void> {
    const fromPath = `${TEST_VAULT_REMOTE}/${fromRelative}`;
    const toPath = `${TEST_VAULT_REMOTE}/${toRelative}`;
    return new Promise((resolve, reject) => {
      this.requireClient().sftp((err, sftp) => {
        if (err) { reject(err); return; }
        sftp.rename(fromPath, toPath, (renameErr) => {
          sftp.end();
          if (renameErr) reject(renameErr);
          else resolve();
        });
      });
    });
  }

  /**
   * Binary read. The utf8 `readFile` above round-trips bytes through a
   * string decode, which silently mangles any non-UTF8 payload (a PNG
   * comes back with U+FFFD where its IDAT bytes were) — so a spec that
   * wants to prove "the image that landed on the remote is byte-identical
   * to the one the vault reflected" has to read it as a Buffer.
   * Returns null if the path is missing.
   */
  async readBinaryFile(relativePath: string): Promise<Buffer | null> {
    const fullPath = `${TEST_VAULT_REMOTE}/${relativePath}`;
    return new Promise((resolve) => {
      this.requireClient().sftp((err, sftp) => {
        if (err) { resolve(null); return; }
        sftp.readFile(fullPath, (readErr, data) => {
          sftp.end();
          if (readErr || !data) { resolve(null); return; }
          resolve(data);
        });
      });
    });
  }

  /**
   * `mkdir -p` on the remote. SFTP's `mkdir` is a single POSIX
   * `mkdir(2)`: it does NOT create intermediate directories, so
   * `writeFile('Sub/x.md')` against a vault with no `Sub/` fails with a
   * bare ENOENT that reads like a broken connection. Creates each path
   * segment in turn and tolerates the segments that already exist.
   *
   * "Already exists" cannot be discriminated by code alone — the server
   * reports it as SSH_FX_FAILURE, the same generic code as a real
   * failure — so a failed `mkdir` is only swallowed once a `stat`
   * confirms a directory is genuinely sitting there.
   */
  async mkdirp(relativePath: string): Promise<void> {
    const segments = relativePath.split('/').filter((s) => s.length > 0);
    await this.withSftp(async (sftp) => {
      let current = TEST_VAULT_REMOTE;
      for (const segment of segments) {
        current += `/${segment}`;
        await mkdirTolerant(sftp, current);
      }
    });
  }

  /**
   * `rm -rf` on the remote: depth-first unlink of files, rmdir of the
   * directories on the way back up. Tolerant of a missing path (an
   * `afterAll` must not turn a red test into two red tests) and of a
   * plain file being passed instead of a directory.
   */
  async rmrf(relativePath: string): Promise<void> {
    await this.withSftp((sftp) =>
      removeRecursive(sftp, `${TEST_VAULT_REMOTE}/${relativePath}`),
    );
  }

  /**
   * Force a file's mtime (POSIX seconds, as SFTP carries it). The
   * cache-staleness scenarios need the remote to report the SAME mtime
   * across two different contents — otherwise the mtime moves on its own
   * and any cache keyed on it invalidates for the wrong reason, so the
   * test would pass without exercising the thing it names. atime is set
   * to the same value; nothing here reads it.
   */
  async setMtime(relativePath: string, mtimeSeconds: number): Promise<void> {
    const fullPath = `${TEST_VAULT_REMOTE}/${relativePath}`;
    return new Promise((resolve, reject) => {
      this.requireClient().sftp((err, sftp) => {
        if (err) { reject(err); return; }
        sftp.utimes(fullPath, mtimeSeconds, mtimeSeconds, (utimesErr) => {
          sftp.end();
          if (utimesErr) reject(utimesErr);
          else resolve();
        });
      });
    });
  }

  /** Delete a file on the remote (for test cleanup). */
  async removeFile(relativePath: string): Promise<void> {
    const fullPath = `${TEST_VAULT_REMOTE}/${relativePath}`;
    return new Promise((resolve) => {
      this.requireClient().sftp((err, sftp) => {
        if (err) { resolve(); return; }
        sftp.unlink(fullPath, () => {
          sftp.end();
          resolve();
        });
      });
    });
  }

  async disconnect(): Promise<void> {
    this.client?.end();
    this.client = null;
  }

  private requireClient(): Client {
    if (!this.client) throw new Error('RemoteVerifier: not connected');
    return this.client;
  }

  /**
   * Run `fn` against ONE sftp session and close it afterwards. The
   * single-shot methods above open a session per call, which is fine for
   * one round-trip; the multi-round-trip ones (`mkdirp` walking segments,
   * `rmrf` recursing a tree) would otherwise open a channel per node and
   * exhaust the server's channel limit on a deep tree.
   */
  private withSftp<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.requireClient().sftp((err, sftp) => {
        if (err) { reject(err); return; }
        fn(sftp).then(
          (value) => { sftp.end(); resolve(value); },
          (fnErr: unknown) => { sftp.end(); reject(fnErr); },
        );
      });
    });
  }
}

/** `mkdir` one segment, treating "it's already a directory" as success. */
function mkdirTolerant(sftp: SFTPWrapper, fullPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sftp.mkdir(fullPath, (err) => {
      if (!err) { resolve(); return; }
      sftp.stat(fullPath, (statErr, attrs) => {
        if (!statErr && attrs?.isDirectory()) resolve();
        else reject(err);
      });
    });
  });
}

/**
 * Depth-first delete of `fullPath`. A missing path resolves silently —
 * cleanup is best-effort by design.
 */
async function removeRecursive(sftp: SFTPWrapper, fullPath: string): Promise<void> {
  const isDir = await new Promise<boolean | null>((resolve) => {
    sftp.lstat(fullPath, (err, attrs) => {
      if (err || !attrs) { resolve(null); return; } // ENOENT — nothing to remove
      resolve(attrs.isDirectory());
    });
  });
  if (isDir === null) return;

  if (!isDir) {
    await new Promise<void>((resolve) => { sftp.unlink(fullPath, () => resolve()); });
    return;
  }

  const entries = await new Promise<FileEntryWithStats[]>((resolve) => {
    sftp.readdir(fullPath, (err, list) => { resolve(err || !list ? [] : list); });
  });
  for (const entry of entries) {
    if (entry.filename === '.' || entry.filename === '..') continue;
    await removeRecursive(sftp, `${fullPath}/${entry.filename}`);
  }

  await new Promise<void>((resolve) => { sftp.rmdir(fullPath, () => resolve()); });
}
