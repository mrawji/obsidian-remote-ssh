import type {
  ReconnectAdapterHooks, RemoteBinding, RpcSessionView,
} from '../ConnectionManager';
import type { SftpDataAdapter } from '../adapter/SftpDataAdapter';
import type { FsChangeListener } from '../vault/FsChangeListener';

/**
 * The adapter-facing half of a reconnect, as three callbacks.
 *
 * `dataAdapter` is a getter, not a value: `restore()` and a failed reconnect
 * both clear it, so a captured one would be stale exactly when it matters.
 *
 * Built here rather than inline in `main.ts` so it can be tested. `rebind` in
 * particular was a one-line lambda that no test reached, and replacing it
 * with an empty function left the suite green — while the binding it carries
 * is what keeps a transport downgrade from writing beside the vault instead
 * of in it.
 */
export function buildReconnectHooks(deps: {
  dataAdapter: () => SftpDataAdapter | null;
  fsChangeListener: Pick<FsChangeListener, 'prepareForReconnect' | 'resumeAfterReconnect'>;
}): ReconnectAdapterHooks {
  return {
    rebind(binding: RemoteBinding): void {
      deps.dataAdapter()?.rebind(binding);
    },
    prepareListenerForReconnect(): void {
      deps.fsChangeListener.prepareForReconnect();
    },
    async resumeListenerAfterReconnect(rpcConn: RpcSessionView): Promise<void> {
      const dataAdapter = deps.dataAdapter();
      // No adapter means the reconnect gave up and `restore()` ran; there is
      // nothing left to point the watch at.
      if (!dataAdapter) return;
      await deps.fsChangeListener.resumeAfterReconnect({ rpcConnection: rpcConn, dataAdapter });
    },
  };
}
