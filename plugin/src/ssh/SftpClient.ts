import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig, KeyboardInteractiveCallback, Prompt, PseudoTtyOptions, SFTPWrapper, Stats } from 'ssh2';
import type { Duplex } from 'stream';
import type { RemoteEntry, RemoteStat, SshProfile } from '../types';
import { TMP_SUFFIX } from '../constants';
import { AuthResolver } from './AuthResolver';
import { CertificateAgent, canSpeakToAgent } from './CertificateAgent';
import { enableCertificateAuth } from './certificateAuth';
import { HostKeyStore, type HostKeyMismatchHandler } from './HostKeyStore';
import { selectTransport } from './Transport';
import { logger } from '../util/logger';
import { asError, errorMessage } from '../util/errorMessage';

export type CloseListener = (info: {
  unexpected: boolean;
  /** What ssh2 said went wrong; see {@link wireConnectionLifecycle}. */
  reason?: Error;
}) => void;

/**
 * Answers a `keyboard-interactive` round (TOTP, PAM PIN, …): one response per
 * prompt, in order. `null` is a cancel and fails the round cleanly.
 *
 * Only the UI layer wires it. Callers that pass nothing leave `tryKeyboard`
 * off entirely.
 */
export type KbdInteractiveHandlerFn = (
  prompts: Array<{ prompt: string; echo: boolean }>,
) => Promise<string[] | null>;

/**
 * A local alias rather than the ambient `BufferEncoding`, which trips
 * ESLint's `no-undef` in the ObsidianReviewBot environment.
 */
type SftpEncoding =
  | 'ascii' | 'utf8' | 'utf-8' | 'utf16le' | 'utf-16le'
  | 'ucs2' | 'ucs-2' | 'base64' | 'base64url' | 'latin1'
  | 'binary' | 'hex';


export interface RemoteEntryWithRel extends RemoteEntry {
  /** Path relative to the listRecursive root (no leading slash). */
  relativePath: string;
}

/**
 * Attach the `error` and `close` handlers a live session needs, and carry
 * the reason from one to the other.
 *
 * Exported for the same reason `wireKeyboardInteractiveHandler` is: it lives
 * inside `connect()`, which needs a real server, so the only way to hold it
 * to anything is to lift it out. The behaviour here was shipped untested and
 * it showed — every post-handshake failure used to be discarded, because the
 * `error` handler's whole job was to reject the connect promise and
 * rejecting a settled promise is a silent no-op.
 *
 * `onError` still rejects that promise (harmless after it settles); what
 * matters is that the error is also remembered, so the `close` that follows
 * can say what happened instead of logging one contentless line.
 */
export function wireConnectionLifecycle(
  client: {
    on(event: 'error', listener: (err: unknown) => void): unknown;
    on(event: 'close', listener: () => void): unknown;
  },
  opts: {
    /** For the log line only. */
    host: string;
    /** Called for every `error`, including ones after the connect settled. */
    onError: (err: Error) => void;
    /** Whether this client is still the one the owner is using. */
    isCurrent: () => boolean;
    /** Drop the owner's references to this client. */
    onTeardown: () => void;
    /** Whether the owner asked for this disconnect. */
    wasIntentional: () => boolean;
    notify: (info: { unexpected: boolean; reason?: Error }) => void;
  },
): void {
  // ssh2 keeps using `error` for the whole session — keepalive timeouts,
  // ECONNRESET, protocol failures — long after the connect promise it was
  // written for has settled. Whatever it last said is the only account of
  // why the session ended.
  let lastError: Error | null = null;

  client.on('error', (err: unknown) => {
    lastError = err instanceof Error ? err : new Error(String(err));
    opts.onError(lastError);
  });

  client.on('close', () => {
    const wasAlive = opts.isCurrent();
    opts.onTeardown();
    if (!wasAlive) return;

    const reason: Error | undefined = lastError ?? undefined;
    logger.warn(
      `SftpClient: connection closed (${opts.host})` +
      (reason ? `: ${errorMessage(reason)}` : ''),
    );
    opts.notify({ unexpected: !opts.wasIntentional(), reason });
  });
}

/**
 * Wire a keyboard-interactive handler onto an EventEmitter-shaped client.
 * Extracted from `SftpClient.connect` so the normalisation, forwarding,
 * and error-recovery logic can be unit-tested without a real ssh2 Client.
 *
 * @internal Exported for testing only.
 */
export function wireKeyboardInteractiveHandler(
  client: {
    on(
      event: 'keyboard-interactive',
      listener: (
        name: string,
        instructions: string,
        lang: string,
        prompts: Prompt[],
        finish: KeyboardInteractiveCallback,
      ) => void,
    ): void;
  },
  handler: KbdInteractiveHandlerFn,
): void {
  client.on('keyboard-interactive', (
    _name: string,
    _instructions: string,
    _lang: string,
    prompts: Prompt[],
    finish: KeyboardInteractiveCallback,
  ) => {
    const normalised = prompts.map(p => ({
      prompt: p.prompt,
      echo:   p.echo ?? false,
    }));
    handler(normalised).then(
      (responses) => {
        finish(responses ?? []);
      },
      (err: unknown) => {
        logger.warn(
          `SftpClient: keyboard-interactive handler threw: ${errorMessage(err)}; failing auth`,
        );
        finish([]);
      },
    );
  });
}

/**
 * Single-connection SFTP wrapper used by the data adapter and by
 * higher-level features (watch poller, resource bridge). Atomic writes
 * are implemented via tmp+rename. The OpenSSH posix-rename extension is
 * preferred when the server advertises it.
 */
export class SftpClient {
  private client: Client | null = null;
  private sftp: SFTPWrapper | null = null;
  private profile: SshProfile | null = null;
  private closeListeners: CloseListener[] = [];
  private intentionalDisconnect = false;
  private remoteHome: string | null = null;

  constructor(
    private authResolver: AuthResolver,
    private hostKeyStore: HostKeyStore,
    /** Enables ssh2's `tryKeyboard` and forwards the challenges here. */
    private kbdInteractiveHandler?: KbdInteractiveHandlerFn,
    /**
     * Switches to ssh2's async `HostVerifier` so a fingerprint change can be
     * answered `'trust'` (re-pin) or `'abort'` (reject the handshake).
     * Without it, a mismatch fails closed.
     */
    private hostKeyMismatchHandler?: HostKeyMismatchHandler,
  ) {}

  // ─── lifecycle ───────────────────────────────────────────────────────────

  isAlive(): boolean {
    return this.client !== null && this.sftp !== null;
  }

  getProfile(): SshProfile | null {
    return this.profile;
  }

  onClose(cb: CloseListener): () => void {
    this.closeListeners.push(cb);
    return () => { this.closeListeners = this.closeListeners.filter(l => l !== cb); };
  }

  async connect(profile: SshProfile): Promise<void> {
    if (this.isAlive()) {
      throw new Error('SftpClient: already connected (call disconnect first)');
    }
    this.profile = profile;
    this.intentionalDisconnect = false;

    logger.info(`SftpClient: connecting to ${profile.host}:${profile.port} as ${profile.username}`);

    const authConfig = this.authResolver.buildAuthConfig(profile);
    // `null` means direct: ssh2 opens its own socket. Anything else is a
    // route with a contract — see `Transport`.
    const transport = selectTransport(profile, {
      authResolver:           this.authResolver,
      hostKeyStore:           this.hostKeyStore,
      hostKeyMismatchHandler: this.hostKeyMismatchHandler,
    });
    let sock: Duplex | undefined;
    if (transport) {
      logger.info(`SftpClient: opening ${transport.name} for ${profile.host}`);
      sock = await transport.open({
        host: profile.host,
        port: profile.port,
        user: profile.username,
      });
    }

    const client = new Client();
    // ssh2 cannot finish an OpenSSH certificate authentication on its own
    // (#536). Inert unless an identity turns out to be a certificate.
    enableCertificateAuth(client);
    await new Promise<void>((resolve, reject) => {
      // Use Obsidian's `activeWindow` timers as required by
      // `obsidianmd/prefer-active-window-timers`. The vitest setup
      // polyfill aliases `activeWindow` to `globalThis` so the same
      // call works under Node-style integration tests.
      const timer = window.setTimeout(() => {
        client.destroy();
        reject(new Error(`Connection timed out after ${profile.connectTimeoutMs}ms`));
      }, profile.connectTimeoutMs);

      client.on('ready', () => {
        window.clearTimeout(timer);
        logger.info(`SftpClient: SSH ready (${profile.host})`);
        resolve();
      });

      wireConnectionLifecycle(client, {
        host: profile.host,
        onError: (err) => {
          window.clearTimeout(timer);
          reject(err);
        },
        isCurrent: () => this.client === client,
        onTeardown: () => {
          this.client = null;
          this.sftp = null;
          this.remoteHome = null;
        },
        wasIntentional: () => this.intentionalDisconnect,
        notify: (info) => {
          for (const cb of [...this.closeListeners]) {
            try { cb(info); }
            catch (e) { logger.warn(`onClose listener threw: ${errorMessage(e)}`); }
          }
        },
      });

      // keyboard-interactive (TOTP / SecurID / Duo Push / PAM PIN).
      // ssh2 only fires this event when `tryKeyboard: true` is in the
      // config AND the server actively asks for it; absence of a
      // handler means we leave the flag off entirely so the previous
      // pubkey/agent/password-only behaviour is preserved bit-for-bit.
      if (this.kbdInteractiveHandler) {
        wireKeyboardInteractiveHandler(client, this.kbdInteractiveHandler);
      }

      // hostVerifier shape switches based on whether a mismatch
      // handler was wired. ssh2's async overload `(key, verify) =>
      // void` lets us await the user's modal choice inside the
      // handshake; without a handler we keep the synchronous boolean
      // overload so tests / non-UI callers retain the exact previous
      // behaviour (fail-closed on mismatch, no async surface).
      const hostVerifier = this.hostKeyMismatchHandler
        ? (key: Buffer, verify: (valid: boolean) => void): void => {
            const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key, 'base64');
            this.hostKeyStore.verifyAsync(
              profile.host,
              profile.port,
              keyBuf,
              this.hostKeyMismatchHandler,
            ).then(verify, (e: unknown) => {
              // verifyAsync already swallows handler errors; this
              // is a defence-in-depth path for impossible failures.
              logger.warn(
                `SftpClient: hostVerifier rejected unexpectedly for ` +
                `${profile.host}:${profile.port}: ${errorMessage(e)}`,
              );
              verify(false);
            });
          }
        : (key: Buffer | string): boolean => {
            const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key, 'base64');
            return this.hostKeyStore.verify(profile.host, profile.port, keyBuf);
          };

      const config: ConnectConfig = {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        keepaliveInterval: profile.keepaliveIntervalMs,
        keepaliveCountMax: profile.keepaliveCountMax,
        readyTimeout: profile.connectTimeoutMs,
        hostVerifier,
        // Only flip tryKeyboard on when a handler exists. The flag's
        // presence makes ssh2 advertise keyboard-interactive in the
        // method list it offers the server — leaving it off when no
        // handler is wired keeps integration tests deterministic
        // (some test sshd images would otherwise prompt).
        ...(this.kbdInteractiveHandler ? { tryKeyboard: true } : {}),
        ...(sock ? { sock } : {}),
        ...authConfig,
        // ssh2's own agent client drops any identity it cannot parse, which
        // is every OpenSSH certificate (#536). Speak to the agent ourselves
        // instead — except for Pageant and Cygwin sockets, whose framing
        // ssh2 handles and we do not.
        ...(typeof authConfig.agent === 'string' && canSpeakToAgent(authConfig.agent)
          ? { agent: new CertificateAgent(authConfig.agent) }
          : {}),
      };

      client.connect(config);
    });

    this.client = client;
    this.sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => err ? reject(asError(err)) : resolve(sftp));
    });
    logger.info(`SftpClient: SFTP channel open`);
  }

  /**
   * Reach the daemon's unix socket through the same SSH connection that
   * already carries SFTP. Needs `direct-streamlocal@openssh.com`, shipped by
   * every mainstream sshd since OpenSSH 6.7.
   */
  async openUnixStream(socketPath: string): Promise<Duplex> {
    const client = this.requireClient();
    return new Promise((resolve, reject) => {
      client.openssh_forwardOutStreamLocal(socketPath, (err: Error | undefined, stream: Duplex) => {
        if (err) reject(asError(err));
        else resolve(stream);
      });
    });
  }

  /**
   * Read a small file off the remote via SFTP. Intended for reading
   * one-shot state like the daemon's session token; for vault files
   * use `readBinary`/`readText` which go through the same channel
   * but return typed buffers directly.
   */
  async readRemoteFile(remotePath: string): Promise<Buffer> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp.readFile(remotePath, (err, buf) => err ? reject(asError(err)) : resolve(buf));
    });
  }

  /**
   * Upload a local file to the remote via SFTP, like scp. Used by the
   * auto-deploy flow to ship `obsidian-remote-server` on connect. The
   * destination directory must already exist; create it via `exec`
   * first if you can't be sure.
   */
  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, { concurrency: 4 }, err => err ? reject(asError(err)) : resolve());
    });
  }

  /**
   * A PTY-backed shell on the same connection as SFTP. The channel is a
   * Duplex — keystrokes in, output out — with `setWindow` for live resize.
   * `cmd` runs a specific program instead of the login shell.
   *
   * The common failure in the wild is `Channel open failure: administratively
   * prohibited`, which means the sshd has `PermitTTY no`; say so rather than
   * showing the raw message.
   */
  async openShell(opts: {
    rows: number;
    cols: number;
    term?: string;
    cmd?: string;
  }): Promise<ClientChannel> {
    const client = this.requireClient();
    const pty: PseudoTtyOptions = {
      rows: opts.rows,
      cols: opts.cols,
      term: opts.term ?? 'xterm-256color',
    };
    return new Promise((resolve, reject) => {
      const cb = (err: Error | undefined, stream: ClientChannel): void => {
        if (err) reject(asError(err));
        else resolve(stream);
      };
      if (opts.cmd) {
        client.exec(opts.cmd, { pty }, cb);
      } else {
        client.shell(pty, cb);
      }
    });
  }

  /**
   * Run a one-shot command on the remote and collect its stdout, stderr,
   * and exit code. Long-running streams (interactive shells, the daemon
   * process itself) should not go through here — they'd never close.
   */
  async exec(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const client = this.requireClient();
    return new Promise((resolve, reject) => {
      client.exec(cmd, (err, stream) => {
        if (err) { reject(asError(err)); return; }
        let stdout = '';
        let stderr = '';
        let exitCode = -1;
        stream.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        stream.on('exit', (code: number) => { exitCode = code; });
        stream.on('close', () => resolve({ stdout, stderr, exitCode }));
        stream.on('error', (e: Error) => reject(asError(e)));
      });
    });
  }

  disconnect(): Promise<void> {
    // Synchronous teardown wrapped in a resolved Promise so the public
    // API (which callers `await`) stays Promise-typed without forcing
    // a no-op `await` (rejected by `require-await`).
    this.intentionalDisconnect = true;
    const client = this.client;
    this.client = null;
    this.sftp = null;
    this.profile = null;
    this.remoteHome = null;
    if (client) {
      try { client.end(); } catch (e) { logger.warn(`SftpClient.disconnect: ${errorMessage(e)}`); }
    }
    return Promise.resolve();
  }

  /**
   * Resolve and cache the remote `$HOME`.
   *
   * Unix-socket forwarding does not chdir on the sshd side: a relative socket
   * path resolves against `/`, not the user's home, so home-relative paths
   * must be absolutised client-side. `$HOME` varies by platform and can be
   * overridden, so it is asked for rather than assumed.
   */
  async getRemoteHome(): Promise<string> {
    if (this.remoteHome) return this.remoteHome;
    const r = await this.exec('echo "$HOME"');
    if (r.exitCode !== 0) {
      throw new Error(
        `SftpClient.getRemoteHome: echo $HOME exited ${r.exitCode}: ${r.stderr.trim() || '(no stderr)'}`,
      );
    }
    const home = r.stdout.trim();
    if (!home) {
      throw new Error('SftpClient.getRemoteHome: $HOME is empty on remote');
    }
    this.remoteHome = home;
    return home;
  }

  // ─── read-side ───────────────────────────────────────────────────────────

  async stat(remotePath: string): Promise<RemoteStat> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) reject(asError(err));
        else resolve(toRemoteStat(stats));
      });
    });
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      await this.stat(remotePath);
      return true;
    } catch {
      return false;
    }
  }

  async list(remotePath: string): Promise<RemoteEntry[]> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) {
          reject(asError(err));
          return;
        }
        const out: RemoteEntry[] = [];
        for (const e of list as ReadonlyArray<{ filename: string; attrs: Stats }>) {
          if (e.filename === '.' || e.filename === '..') continue;
          out.push(toRemoteEntryFromStats(e.filename, e.attrs));
        }
        resolve(out);
      });
    });
  }

  async listRecursive(
    rootPath: string,
    filter?: (relativePath: string) => boolean,
  ): Promise<RemoteEntryWithRel[]> {
    const out: RemoteEntryWithRel[] = [];
    const queue: string[] = [rootPath];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const dir = queue.shift()!;
      let entries: RemoteEntry[];
      try {
        entries = await this.list(dir);
      } catch (e) {
        logger.warn(`listRecursive: cannot readdir "${dir}": ${errorMessage(e)}`);
        continue;
      }
      for (const entry of entries) {
        const full = `${dir}/${entry.name}`;
        const rel = full.slice(rootPath.length + 1);
        if (filter && !filter(rel)) continue;
        out.push({ ...entry, relativePath: rel });
        if (entry.isDirectory && !visited.has(full)) {
          visited.add(full);
          queue.push(full);
        }
      }
    }
    return out;
  }

  async readBinary(remotePath: string): Promise<Buffer> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp.readFile(remotePath, (err, buf) => err ? reject(asError(err)) : resolve(buf));
    });
  }

  async readText(remotePath: string, encoding: SftpEncoding = 'utf8'): Promise<string> {
    const buf = await this.readBinary(remotePath);
    return buf.toString(encoding);
  }

  // ─── write-side ──────────────────────────────────────────────────────────

  async writeBinary(remotePath: string, data: Buffer): Promise<void> {
    return this.atomicWrite(remotePath, data);
  }

  async writeText(remotePath: string, data: string, encoding: SftpEncoding = 'utf8'): Promise<void> {
    return this.atomicWrite(remotePath, Buffer.from(data, encoding));
  }

  /** Best-effort overwrite via tmp file + atomic rename. Cleans up tmp on failure. */
  private async atomicWrite(remotePath: string, data: Buffer): Promise<void> {
    const sftp = this.requireSftp();
    const tmpPath = remotePath + TMP_SUFFIX;
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.writeFile(tmpPath, data, err => err ? reject(asError(err)) : resolve());
      });
      await this.rename(tmpPath, remotePath);
    } catch (e) {
      try { await this.remove(tmpPath); } catch { /* ignore cleanup failure */ }
      throw e;
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      const sftpAny = sftp as unknown as {
        _extensions?: Record<string, unknown>;
        ext_openssh_rename?: (src: string, dst: string, cb: (err: Error | undefined) => void) => void;
      };
      if (sftpAny._extensions && sftpAny._extensions['posix-rename@openssh.com'] && sftpAny.ext_openssh_rename) {
        sftpAny.ext_openssh_rename(oldPath, newPath, err => err ? reject(asError(err)) : resolve());
      } else {
        sftp.rename(oldPath, newPath, err => err ? reject(asError(err)) : resolve());
      }
    });
  }

  async copy(srcPath: string, destPath: string): Promise<void> {
    // SFTP has no native copy; round-trip via memory.
    const data = await this.readBinary(srcPath);
    await this.writeBinary(destPath, data);
  }

  async remove(remotePath: string): Promise<void> {
    const sftp = this.requireSftp();
    return new Promise((resolve, reject) => {
      sftp.unlink(remotePath, err => err ? reject(asError(err)) : resolve());
    });
  }

  /**
   * Create the directory, treating "already exists" as success.
   *
   * OpenSSH reports an existing directory as SSH_FX_FAILURE with the opaque
   * message "Failure", so matching on "exist" misses it. Stat first: a
   * directory means done, a non-directory is a real conflict, anything else
   * goes to mkdir.
   */
  async mkdir(remotePath: string): Promise<void> {
    const sftp = this.requireSftp();
    try {
      const s = await this.stat(remotePath);
      if (s.isDirectory) return;
      throw new Error(`mkdir: "${remotePath}" exists and is not a directory`);
    } catch (e) {
      // Treat any stat failure as "path is not there yet" and try to create it.
      if (errorMessage(e)?.startsWith('mkdir: ')) throw e;
    }
    return new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, err => {
        if (err && !err.message.toLowerCase().includes('exist')) reject(asError(err));
        else resolve();
      });
    });
  }

  async mkdirp(remotePath: string): Promise<void> {
    const isAbs = remotePath.startsWith('/');
    const parts = remotePath.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = isAbs
        ? current + '/' + part
        : (current ? current + '/' + part : part);
      await this.mkdir(current);
    }
  }

  async rmdir(remotePath: string, recursive = false): Promise<void> {
    const sftp = this.requireSftp();
    if (recursive) {
      const entries = await this.listRecursive(remotePath);
      const depth = (p: string) => p.split('/').length;
      const files = entries.filter(e => !e.isDirectory);
      const dirs = entries.filter(e => e.isDirectory).sort((a, b) => depth(b.relativePath) - depth(a.relativePath));
      for (const f of files) {
        await this.remove(`${remotePath}/${f.relativePath}`);
      }
      for (const d of dirs) {
        await new Promise<void>((resolve, reject) => {
          sftp.rmdir(`${remotePath}/${d.relativePath}`, err => err ? reject(asError(err)) : resolve());
        });
      }
    }
    return new Promise((resolve, reject) => {
      sftp.rmdir(remotePath, err => err ? reject(asError(err)) : resolve());
    });
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  private requireSftp(): SFTPWrapper {
    if (!this.sftp) throw new Error('SftpClient: not connected');
    return this.sftp;
  }

  private requireClient(): Client {
    if (!this.client) throw new Error('SftpClient: not connected');
    return this.client;
  }
}

function toRemoteStat(stats: Stats): RemoteStat {
  return {
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    isSymbolicLink: stats.isSymbolicLink(),
    mtime: stats.mtime * 1000,
    size: stats.size,
    mode: stats.mode,
  };
}

function toRemoteEntryFromStats(name: string, stats: Stats): RemoteEntry {
  return {
    name,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    isSymbolicLink: stats.isSymbolicLink(),
    mtime: stats.mtime * 1000,
    size: stats.size,
  };
}
