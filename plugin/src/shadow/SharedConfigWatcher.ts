import { SHARED_OBSIDIAN_CONFIG_FILES } from './SharedObsidianConfigSync';
import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';

/**
 * Injectable surface so the debounce / diff / echo-suppression logic
 * is unit-testable without a real filesystem watcher or timers.
 */
export interface SharedConfigWatcherDeps {
  /**
   * Start watching the local config dir. `onChange` is invoked with
   * the changed file's basename, or `null` when the platform doesn't
   * report a filename (treat as "any shared file may have changed").
   * Returns a closer.
   */
  watch(onChange: (filename: string | null) => void): { close(): void };
  /** Current local content of `<configDir>/<basename>`, or null if absent/unreadable. */
  readLocal(basename: string): string | null;
  /** Push the changed shared-config basenames to the remote. */
  flush(changed: readonly string[]): Promise<void>;
  /** Debounce window; coalesces a burst of saves into one push. */
  debounceMs: number;
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/**
 * Closes the #342 round-trip's push half.
 *
 * `pullSharedObsidianConfig` brings remote shared config → local on
 * connect, but nothing carried a LOCAL settings change back to the
 * remote, so it never survived to the next session. This watches the
 * shadow vault's local config dir and pushes a changed shared-config
 * file to the remote — regardless of whether Obsidian wrote it via
 * the patched adapter or a direct `fs` write (a real fs watcher sees
 * both, since the shadow `.obsidian/` is local disk).
 *
 * Echo-suppression: the post-pull writes (and Obsidian re-saving an
 * identical file on open) MUST NOT bounce straight back to the
 * remote. `markSynced` records the last content known to match the
 * remote; a debounced flush only pushes files whose current content
 * differs from that. So a real edit pushes; a pull echo / no-op save
 * does not.
 */
export class SharedConfigWatcher {
  private static readonly SHARED = new Set<string>(
    SHARED_OBSIDIAN_CONFIG_FILES,
  );

  private closer: { close(): void } | null = null;
  private timer: unknown = null;
  private readonly dirty = new Set<string>();
  /** Per-basename content last known to equal the remote copy. */
  private readonly synced = new Map<string, string>();

  constructor(private readonly deps: SharedConfigWatcherDeps) {}

  /**
   * Record content that already matches the remote (call right after
   * a successful pull, with the bytes just written locally) so the
   * watcher does not echo the pull's own writes back out.
   */
  markSynced(basename: string, content: string): void {
    this.synced.set(basename, content);
  }

  start(): void {
    if (this.closer) return;
    this.closer = this.deps.watch((filename) => this.onEvent(filename));
  }

  stop(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.closer) {
      try { this.closer.close(); } catch { /* best effort */ }
      this.closer = null;
    }
    this.dirty.clear();
  }

  private onEvent(filename: string | null): void {
    if (filename === null) {
      // No filename from the platform — consider every shared file.
      for (const f of SharedConfigWatcher.SHARED) this.dirty.add(f);
    } else {
      const base = filename.replace(/^.*[\\/]/, '');
      if (!SharedConfigWatcher.SHARED.has(base)) return;
      this.dirty.add(base);
    }
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.fire();
    }, this.deps.debounceMs);
  }

  private async fire(): Promise<void> {
    const candidates = [...this.dirty];
    this.dirty.clear();
    const changed: string[] = [];
    for (const base of candidates) {
      const content = this.deps.readLocal(base);
      if (content === null) continue;            // deleted/unreadable — skip
      if (this.synced.get(base) === content) continue; // pull echo / no-op save
      changed.push(base);
    }
    if (changed.length === 0) return;
    try {
      await this.deps.flush(changed);
      // Only mark synced once the push actually succeeded, so a
      // failed push is retried on the next change instead of being
      // masked as "already in sync".
      for (const base of changed) {
        const c = this.deps.readLocal(base);
        if (c !== null) this.synced.set(base, c);
      }
    } catch (e) {
      logger.warn(`SharedConfigWatcher: push failed (${errorMessage(e)})`);
    }
  }
}
