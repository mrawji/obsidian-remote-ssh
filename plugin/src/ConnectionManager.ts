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
   */
  onRpcClose: () => void;
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
 * Hooks the reconnect attempt calls after re-establishing the transport
 * so the plugin can rebind the adapter and fs-change listener.
 */
export interface ReconnectAdapterHooks {
  swapClient(newClient: RemoteFsClient): void;
  prepareListenerForReconnect(): void;
  resumeListenerAfterReconnect(rpcConn: RpcConnectionHandle): Promise<void>;
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
  rpcConnection: RpcConnectionHandle | null = null;

  /**
   * Set while we are the ones closing the RPC wire, so the close handler
   * above can tell "we hung up" from "it died". Mirrors `SftpClient`'s
   * `intentionalDisconnect`; without it, every manual disconnect and every
   * reconnect pass would kick off a reconnect of its own.
   */
  private closingRpcIntentionally = false;
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
        this.rpcConnection = reused;
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
    this.rpcConnection = await establishRpcConnection({ stream, token: deploy.token });
    logger.info(
      `startRpcSession: handshake complete; daemon ${this.rpcConnection.info.version} ` +
      `(protocol v${this.rpcConnection.info.protocolVersion})`,
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
    this.rpcConnection?.rpc.onClose((err) => {
      if (this.closingRpcIntentionally) return;
      logger.warn(`RPC wire closed unexpectedly${err ? `: ${errorMessage(err)}` : ''}`);
      this.deps.onRpcClose();
    });
  }

  /** Close RPC tunnel, stop daemon, disconnect SSH. */
  async disconnectTransport(): Promise<void> {
    if (this.rpcConnection) {
      this.closingRpcIntentionally = true;
      try { this.rpcConnection.close(); }
      catch (e) { logger.warn(`rpcConnection.close: ${errorMessage(e)}`); }
      finally { this.closingRpcIntentionally = false; }
      this.rpcConnection = null;
    }
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
    if (this.rpcConnection) {
      this.closingRpcIntentionally = true;
      try { this.rpcConnection.close(); } catch { /* already dead */ }
      finally { this.closingRpcIntentionally = false; }
      this.rpcConnection = null;
    }
    if (transport === 'rpc') {
      const effectivePath = this.activeRemoteBasePath ?? normalizeRemotePath(profile.remotePath);
      try {
        await this.startRpcSession(profile, effectivePath);
      } catch (e) {
        // Same downgrade the initial connect does (main.ts connectProfile):
        // a permanent daemon-unavailable condition (unsupported arch /
        // declined / download failed) must NOT be retried by
        // ReconnectManager. Continue with rpcConnection still null so
        // buildFsClient() yields an SFTP client. Any other error propagates
        // to the reconnect retry loop as before.
        if (e instanceof DaemonUnavailableError) {
          logger.warn(`reconnectAttempt: daemon unavailable, continuing on SFTP: ${e.message}`);
        } else {
          throw e;
        }
      }
    }

    hooks.swapClient(this.buildFsClient());

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

  /** Build an appropriate RemoteFsClient for the current transport. */
  buildFsClient(): RemoteFsClient {
    return this.rpcConnection
      ? new RpcRemoteFsClient(this.rpcConnection.rpc)
      : new SftpRemoteFsClient(this.client);
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
