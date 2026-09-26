import { SftpClient } from './ssh/SftpClient';
import type { SshProfile } from './types';
import type { RemoteFsClient } from './adapter/RemoteFsClient';
import { RpcRemoteFsClient } from './adapter/RpcRemoteFsClient';
import { SftpRemoteFsClient } from './adapter/SftpRemoteFsClient';
import { ReconnectManager } from './transport/ReconnectManager';
import type { ReconnectState } from './transport/ReconnectManager';
import { DEFAULT_BACKOFF } from './transport/Backoff';
import { ServerDeployer, resolveRemotePath } from './transport/ServerDeployer';
import { tryReuseExistingDaemon } from './transport/DaemonProbe';
import { RpcHeartbeat } from './transport/RpcHeartbeat';
import { establishRpcConnection } from './transport/RpcConnection';
import { normalizeRemotePath, sameRemotePath } from './util/pathUtils';
import { logger } from './util/logger';
import { errorMessage } from './util/errorMessage';
import { sanitizeClientId, defaultClientId, defaultUserName } from './path/PathMapper';

export type RpcConnectionHandle = Awaited<ReturnType<typeof establishRpcConnection>>;

export interface ConnectionDeps {
  locateDaemonBinary: () => string | null;
  /**
   * Download + cache the daemon binary for the remote's arch when it isn't
   * staged locally (community-store installs don't ship it). Returns the
   * local path, or null when the remote arch is unsupported or the user
   * declined the download — the caller then downgrades to SFTP.
   */
  ensureDaemonBinary: (client: SftpClient) => Promise<string | null>;
  /**
   * The RPC wire died on its own — the daemon was killed, crashed, or its
   * channel closed — while SSH itself is still up.
   *
   * Without this the plugin had no way to find out. Reconnect is driven off
   * `SftpClient`'s close, and that only fires when the *SSH* connection
   * goes; a daemon dying underneath a healthy session produced no reconnect,
   * no notice and no log line, while every later file operation failed one
   * at a time with "stream is closed" and the status bar still said
   * connected.
   *
   * @param reason why the wire died, when the layer that noticed could tell.
   */
  onRpcClose: (reason?: Error) => void;
}

/**
 * Raised by {@link ConnectionManager.startRpcSession} when no daemon binary
 * could be obtained: an unsupported remote arch, a declined download, or a
 * benign download failure (network / 404). The connect AND reconnect flows
 * catch it and fall back to SFTP transport. (A sha256/integrity failure is
 * NOT this error — that surfaces loudly as a generic connect error.)
 */
export class DaemonUnavailableError extends Error {}

/**
 * The remote, as the adapter has to see it: which client to talk through,
 * and what to join vault-relative paths with. One value because a reconnect
 * can change both at once — see {@link ConnectionManager.buildBinding}.
 */
export interface RemoteBinding {
  client: RemoteFsClient;
  remoteBase: string;
}

/**
 * Hooks the reconnect attempt calls after re-establishing the transport
 * so the plugin can rebind the adapter and fs-change listener.
 */
/**
 * The live session as everyone outside this class may see it: everything the
 * daemon can be asked, and no way to hang up.
 *
 * Making the field read-only stopped it being *replaced*, which was the bug —
 * but the handle it returns still had a public `close()`, and so did the client
 * inside it, so `conn.rpcConnection?.close()` and `?.rpc.close()` both still
 * compiled. Closing the wire has to go through the manager, because that is
 * what lets the close handler tell a teardown from a death; omitting `close`
 * from the declared type is what actually enforces it.
 */
export interface RpcSessionView {
  readonly info: RpcConnectionHandle['info'];
  readonly rpc: RpcCallSurface;
}

/** Everything an RpcClient offers except the ability to close it. */
export type RpcCallSurface = Omit<RpcConnectionHandle['rpc'], 'close'>;

export interface ReconnectAdapterHooks {
  rebind(binding: RemoteBinding): void;
  prepareListenerForReconnect(): void;
  resumeListenerAfterReconnect(rpcConn: RpcSessionView): Promise<void>;
}

/**
 * Owns the SSH / RPC transport lifecycle: connect, deploy daemon,
 * handshake, disconnect, and the reconnect loop.
 *
 * Adapter patching, vault population, and Obsidian UI remain in the
 * plugin class — ConnectionManager talks back to them via callbacks.
 */
export class ConnectionManager {
  activeProfile: SshProfile | null = null;
  activeRemoteBasePath: string | null = null;

  private _rpcConnection: RpcConnectionHandle | null = null;

  /**
   * Read-only on purpose: closing the wire goes through this class, which is
   * what lets the close handler tell a teardown from a death by comparing
   * against this field.
   *
   * `restartDaemon` used to close it directly from the plugin. The result was
   * a toast saying the connection had been lost for a button the user had
   * just pressed, and a reconnect racing the restart — two
   * `ServerDeployer.deploy` passes, each with `killExisting`, against the
   * same socket and token.
   */
  get rpcConnection(): RpcSessionView | null { return this._rpcConnection; }

  /** Watches for a daemon that stops answering without the wire dropping. */
  private heartbeat: RpcHeartbeat | null = null;
  daemonDeployer: ServerDeployer | null = null;
  reconnectManager: ReconnectManager | null = null;

  constructor(
    readonly client: SftpClient,
    private readonly deps: ConnectionDeps,
  ) {}

  // ─── connect / disconnect ─────────────────────────────────────────

  /** Connect SSH and run a smoke-test `list`. Throws on failure. */
  async connectSsh(profile: SshProfile): Promise<void> {
    const effectivePath = normalizeRemotePath(profile.remotePath);
    if (effectivePath !== profile.remotePath) {
      logger.info(`remotePath normalized: "${profile.remotePath}" → "${effectivePath}"`);
    }
    await this.client.connect(profile);
    const entries = await this.client.list(effectivePath);
    logger.info(`Smoke test: list ${effectivePath} returned ${entries.length} entries`);
    this.activeRemoteBasePath = effectivePath;
    this.activeProfile = profile;
  }

  /**
   * Deploy the daemon binary, open a unix-socket Duplex, and run
   * the `auth` + `server.info` handshake. On success `rpcConnection`
   * and `daemonDeployer` are populated.
   */
  async startRpcSession(profile: SshProfile, effectivePath: string): Promise<void> {
    // Prefer a locally-staged binary (dev builds); otherwise download +
    // cache the right per-arch binary from the GitHub release (the path
    // community-store installs take, since the package can't ship it).
    const localBinaryPath =
      this.deps.locateDaemonBinary() ?? (await this.deps.ensureDaemonBinary(this.client));
    if (!localBinaryPath) {
      throw new DaemonUnavailableError(
        'daemon binary unavailable: the remote arch is unsupported or the download was declined.',
      );
    }

    const remoteBinaryPath = '.obsidian-remote/server';
    const remoteSocketPath = profile.rpcSocketPath?.trim() || '.obsidian-remote/server.sock';
    const remoteTokenPath  = profile.rpcTokenPath?.trim()  || '.obsidian-remote/token';

    const home = await this.client.getRemoteHome();
    const absSocketPath = resolveRemotePath(remoteSocketPath, home);
    const absTokenPath  = resolveRemotePath(remoteTokenPath,  home);

    // Absolute vault root, computed ONCE and used both for the
    // reuse-validation compare and as the daemon's `--vault-root`
    // (removes the daemon's implicit cwd dependency and keeps both
    // sides of the compare in the same path space — see the
    // `sameRemotePath` JSDoc for the normalisation rationale).
    const absVaultRoot = resolveRemotePath(effectivePath, home);

    const reused = await tryReuseExistingDaemon(this.client, absSocketPath, absTokenPath);
    if (reused) {
      // A daemon is already running, but its vault-root was fixed at
      // its deploy time. If the profile's remotePath changed (or the
      // old root was deleted), reusing it would silently serve the
      // wrong/missing tree → empty vault, every op `no such file`.
      // Validate the root and redeploy automatically on mismatch so
      // the user never has to SSH in and pkill the daemon by hand.
      // `vaultRoot` is typed string but an older / third-party daemon
      // can omit it on the wire → guard with `?? ''` (empty never
      // matches a real root, so it redeploys, which is correct).
      const haveRoot = reused.info.vaultRoot ?? '';
      if (sameRemotePath(haveRoot, absVaultRoot)) {
        this._rpcConnection = reused;
        this.watchRpcWire();
        logger.info(
          `startRpcSession: reusing existing daemon for ${absVaultRoot} ` +
          `(vaultRoot=${haveRoot}, skipped kill+redeploy)`,
        );
        return;
      }
      logger.warn(
        `startRpcSession: existing daemon serves vaultRoot="${haveRoot}" but this ` +
        `profile needs "${absVaultRoot}" — killing + redeploying so the profile's ` +
        `remotePath takes effect (no manual pkill needed)`,
      );
      try {
        reused.close();
      } catch (e) {
        // best effort — deploy() pkills + rm's socket/token anyway;
        // logged (like every other close in this file) so a wedged
        // transport leaves a trace instead of vanishing.
        logger.warn(`startRpcSession: reused.close() on mismatch: ${errorMessage(e)}`);
      }
      // fall through to deploy(): killExisting:true pkills the stale
      // daemon and redeploys at the correct vault-root.
    }

    logger.info(`startRpcSession: deploying daemon to serve ${absVaultRoot}`);
    const deployer = new ServerDeployer(this.client);
    const deploy = await deployer.deploy({
      localBinaryPath,
      remoteBinaryPath,
      remoteVaultRoot: absVaultRoot,
      remoteSocketPath,
      remoteTokenPath,
    });
    this.daemonDeployer = deployer;
    logger.info(`startRpcSession: daemon up; token len=${deploy.token.length}`);

    const stream = await this.client.openUnixStream(deploy.remoteSocketPath);
    const conn = await establishRpcConnection({ stream, token: deploy.token });
    this._rpcConnection = conn;
    logger.info(
      `startRpcSession: handshake complete; daemon ${conn.info.version} ` +
      `(protocol v${conn.info.protocolVersion})`,
    );

    this.watchRpcWire();
  }

  /**
   * Notice when the RPC wire dies on its own.
   *
   * The RPC channel has its own mortality, separate from SSH's: a daemon
   * that is killed or crashes takes it down while the SSH session stays
   * perfectly healthy, so nothing else in the plugin would find out.
   *
   * Called from BOTH places that install an `rpcConnection` — the fresh
   * handshake and the reuse of an already-running daemon. Watching only the
   * first would leave the commonest case in a long session, reconnecting to
   * a daemon that is already up, as silent as before.
   */
  private watchRpcWire(): void {
    const conn = this._rpcConnection;
    if (!conn) return;

    conn.rpc.onClose((err) => {
      // Identity, not a flag. This handler belongs to `conn`; if the manager
      // has moved on, the close is either one we asked for or one for a wire
      // nobody owns any more, and either way it is not news.
      //
      // A boolean could only cover a close arriving in the same turn as our
      // own `close()` call, and that held solely because `FramedDuplex.close()`
      // emits synchronously — a fact three modules away. Killing the daemon
      // drops the wire from the far end on its own schedule, so that close
      // landed after the flag was already down: a toast saying the connection
      // was lost, a reconnect racing the restart, and `stopHeartbeat()` here
      // killing the heartbeat of the session that had just replaced this one.
      if (this._rpcConnection !== conn) return;
      logger.warn(`RPC wire closed unexpectedly${err ? `: ${errorMessage(err)}` : ''}`);
      this.stopHeartbeat();
      this.deps.onRpcClose(err);
    });

    // A closed wire is the loud case. The quiet one is a daemon that is
    // still there as far as TCP and SSH are concerned but has stopped
    // answering — the machine that slept, the process the OOM killer took
    // by surprise. Nothing below the RPC layer notices that, and a call
    // made into it simply never returns.
    this.stopHeartbeat();
    this.heartbeat = new RpcHeartbeat({
      // The client itself, not a handful of callbacks onto it: wiring them
      // separately is how a stubbed `pendingCount` came to describe a client
      // that could not exist.
      rpc: conn.rpc,
      onDead: (reason) => {
        // Same reasoning as the close handler above.
        if (this._rpcConnection !== conn) return;
        logger.warn(`RPC heartbeat: ${reason.message}`);
        this.deps.onRpcClose(reason);
      },
    });
    this.heartbeat.start();
  }

  private stopHeartbeat(): void {
    this.heartbeat?.stop();
    this.heartbeat = null;
  }

  /**
   * Drop the wire deliberately.
   *
   * Releasing the field BEFORE closing is the whole trick: the close handler
   * compares identity, so once we have let go it does not matter whether the
   * close lands this turn or three ticks from now.
   */
  private closeRpcIntentionally(): void {
    const conn = this._rpcConnection;
    if (!conn) return;
    this.stopHeartbeat();
    this._rpcConnection = null;
    try { conn.close(); }
    catch (e) { logger.warn(`rpcConnection.close: ${errorMessage(e)}`); }
  }

  /**
   * Stop the daemon and drop the wire, for a caller that means to bring both
   * straight back up.
   *
   * Release first, again: killing the far end drops the connection from over
   * there, and that close can arrive after this method has already returned
   * and a new session is up. Nothing here has to hold a window open.
   */
  async teardownRpcSession(): Promise<void> {
    this.stopHeartbeat();
    const conn = this._rpcConnection;
    this._rpcConnection = null;
    if (this.daemonDeployer && this.client.isAlive()) {
      try { await this.daemonDeployer.stop(); }
      catch (e) { logger.warn(`daemon stop: ${errorMessage(e)}`); }
    }
    if (conn) {
      try { conn.close(); }
      catch (e) { logger.warn(`rpcConnection.close: ${errorMessage(e)}`); }
    }
    this.daemonDeployer = null;
  }

  /** Close RPC tunnel, stop daemon, disconnect SSH. */
  async disconnectTransport(): Promise<void> {
    this.closeRpcIntentionally();
    if (this.daemonDeployer && this.client.isAlive()) {
      try { await this.daemonDeployer.stop(); }
      catch (e) { logger.warn(`daemon stop: ${errorMessage(e)}`); }
    }
    this.daemonDeployer = null;

    if (this.client.isAlive()) {
      try { await this.client.disconnect(); }
      catch (e) { logger.warn(`disconnect: ${errorMessage(e)}`); }
    }
    this.activeProfile = null;
    this.activeRemoteBasePath = null;
  }

  // ─── reconnect ────────────────────────────────────────────────────

  /**
   * Drive the reconnect loop after an unexpected SSH drop.
   * Idempotent: a second call while a loop is active is a no-op.
   */
  async startReconnect(opts: {
    maxRetries: number;
    setAdapterReconnecting: (on: boolean) => void;
    onState: (s: ReconnectState) => void;
    hooks: ReconnectAdapterHooks;
  }): Promise<void> {
    if (this.reconnectManager?.isActive()) return;
    if (!this.activeProfile) {
      logger.warn('startReconnect: no active profile to reconnect with');
      return;
    }
    if (opts.maxRetries <= 0) {
      logger.info('startReconnect: auto-reconnect disabled (reconnectMaxRetries <= 0)');
      return;
    }
    opts.setAdapterReconnecting(true);
    const manager = new ReconnectManager({
      attempt: () => this.reconnectAttempt(opts.hooks),
      onState: opts.onState,
      backoff: { ...DEFAULT_BACKOFF, maxRetries: opts.maxRetries },
    });
    this.reconnectManager = manager;
    await manager.run();
  }

  /**
   * One reconnect pass: re-establish SSH, redeploy RPC if needed,
   * rebind the adapter client, and re-subscribe the fs listener.
   */
  private async reconnectAttempt(hooks: ReconnectAdapterHooks): Promise<void> {
    const profile = this.activeProfile;
    if (!profile) throw new Error('no active profile');

    if (!this.client.isAlive()) {
      await this.client.connect(profile);
    }

    const transport = profile.transport ?? 'sftp';
    this.closeRpcIntentionally();
    if (transport === 'rpc') {
      const effectivePath = this.activeRemoteBasePath ?? normalizeRemotePath(profile.remotePath);
      try {
        await this.startRpcSession(profile, effectivePath);
      } catch (e) {
        // Same downgrade the initial connect does (main.ts connectProfile):
        // a permanent daemon-unavailable condition (unsupported arch /
        // declined / download failed) must NOT be retried by
        // ReconnectManager. Continue with rpcConnection still null so
        // {@link buildBinding} yields the SFTP client AND the vault prefix
        // that transport needs. Any other error propagates to the retry loop.
        if (e instanceof DaemonUnavailableError) {
          logger.warn(`reconnectAttempt: daemon unavailable, continuing on SFTP: ${e.message}`);
        } else {
          throw e;
        }
      }
    }

    // Both halves, because this pass may have changed transport: the
    // downgrade a few lines up leaves `rpcConnection` null and switches the
    // adapter to SFTP, which needs the vault prefix the RPC session did not.
    hooks.rebind(this.buildBinding());

    hooks.prepareListenerForReconnect();
    if (this.rpcConnection) {
      await hooks.resumeListenerAfterReconnect(this.rpcConnection);
    }
  }

  cancelReconnect(): void {
    if (!this.reconnectManager?.isActive()) return;
    this.reconnectManager.cancel();
    this.reconnectManager = null;
  }

  // ─── helpers ──────────────────────────────────────────────────────

  /**
   * Everything about the remote that a reconnect can change, in one value.
   *
   * The client and the path prefix are not independent — they are two halves
   * of one decision, because the daemon already knows the vault root from
   * its `--vault-root` flag and wants paths relative to it, while SFTP has
   * no such server and needs the prefix to anchor at the vault.
   *
   * They used to be computed in different places: the client here, the
   * prefix in `AdapterManager.patch()`. A reconnect swapped the client and
   * left the prefix from the previous transport — and a reconnect CAN change
   * transport, by downgrading to SFTP when the daemon turns out to be
   * unavailable. RPC→SFTP then dropped the vault prefix from every path
   * (writes landing beside the vault rather than in it); SFTP→RPC doubled
   * it. Returning both together is what makes that combination
   * unrepresentable.
   */
  buildBinding(): RemoteBinding {
    return this.rpcConnection
      ? { client: new RpcRemoteFsClient(this.rpcConnection.rpc), remoteBase: '' }
      : { client: new SftpRemoteFsClient(this.client), remoteBase: this.activeRemoteBasePath ?? '' };
  }

  isAlive(): boolean {
    return this.client.isAlive();
  }

  static resolveClientId(settings: { clientId?: string }): string {
    const override = (settings.clientId ?? '').trim();
    if (override) return sanitizeClientId(override);
    return defaultClientId();
  }

  static formatUserLabel(settings: { clientId?: string; userName?: string }): string {
    const userName = settings.userName?.trim() || defaultUserName();
    const clientId = ConnectionManager.resolveClientId(settings);
    return `${userName}@${clientId}`;
  }
}
