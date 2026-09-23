import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/ui/RemoteTerminalView', () => ({
  RemoteTerminalView: class {}, VIEW_TYPE_REMOTE_TERMINAL: 'remote-terminal',
}));
vi.mock('obsidian', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  class TFile {
    stat = { ctime: 0, mtime: 0, size: 0 };
    constructor(public vault: unknown, public path: string) {}
  }
  class TFolder extends TFile { children: unknown[] = []; }
  return { ...original, TFile, TFolder };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, TFile, TFolder } from 'obsidian';
import RemoteSshPlugin from '../src/main';
import { writeTreeSnapshot } from '../src/vault/TreeSnapshot';
import type { RemoteEntry } from '../src/vault/VaultModelBuilder';

/**
 * The startup half of #513: last session's tree goes into `vault.fileMap`
 * during `onload`, before Obsidian's `metadataCache.initialize()` deletes
 * every cached note it cannot see.
 *
 * What these pin is the part that is dangerous to get wrong: which notes the
 * plugin will later repair. `snapshotFiles` gates both the post-connect
 * re-index of notes with no metadata and the stat zeroing that is the only
 * thing correcting a restored stat on an SFTP session — so it has to describe
 * everything the restore ATTEMPTED, not only what the insert managed.
 */

const REMOTE = '/srv/vault';
const entry = (p: string, isDirectory = false): RemoteEntry =>
  ({ path: p, isDirectory, ctime: 5, mtime: 5, size: 50 });

let stateRoot: string;
let realHome: string | undefined;

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-snapshot-'));
  // `treeSnapshotFile` resolves under `~/.obsidian-remote/state/<profile>/`,
  // and `os.homedir()` reads $HOME on posix / $USERPROFILE on Windows. The
  // export itself cannot be spied on under ESM.
  realHome = process.env.HOME;
  process.env.HOME = stateRoot;
  process.env.USERPROFILE = stateRoot;
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

interface Internals {
  settings: unknown;
  snapshotFiles: Set<string> | null;
  restoreTreeSnapshot: () => Promise<void>;
  treeSnapshotFile: (profileId: string) => string;
}

/**
 * A plugin bound to a fake vault. `insertsFail` makes every insert fail the
 * way a real one does when the model is unusable (no root to hang entries
 * off), which is the partial-restore shape: some or no entries land, and the
 * restore still has to hand the repair machinery the full list.
 */
function makePlugin(opts: { entries: RemoteEntry[]; insertsFail?: boolean }) {
  const app = new App();
  const fileMap: Record<string, TFile | TFolder> = {};
  const root = new TFolder(app.vault, '');
  Object.assign(app.vault, {
    fileMap,
    configDir: '.obsidian',
    getRoot: () => (opts.insertsFail ? null : root),
    getAbstractFileByPath: (p: string) => fileMap[p] ?? null,
    getAllLoadedFiles: () => [root, ...Object.values(fileMap)],
    trigger: vi.fn(),
  });

  const plugin = new RemoteSshPlugin(app);
  const internal = plugin as unknown as Internals;
  const profile = {
    id: 'profile-1', name: 'p', remotePath: REMOTE,
    walkIgnoreDirs: ['node_modules'], allowedHiddenDirs: [] as string[],
  };
  internal.settings = {
    autoConnectProfileId: profile.id, profiles: [profile], lazyFolderLoad: true,
  };
  writeTreeSnapshot(internal.treeSnapshotFile(profile.id), REMOTE, opts.entries);
  return { plugin, internal, fileMap, app };
}

describe('restoreTreeSnapshot', () => {
  it('puts last session tree into the model', async () => {
    const { internal, fileMap } = makePlugin({
      entries: [entry('notes', true), entry('notes/a.md'), entry('b.md')],
    });

    await internal.restoreTreeSnapshot();

    expect(Object.keys(fileMap).sort()).toEqual(['b.md', 'notes', 'notes/a.md']);
    expect([...internal.snapshotFiles ?? []].sort()).toEqual(['b.md', 'notes/a.md']);
  });

  it('records what it will restore BEFORE it inserts any of it', async () => {
    // `buildChunked` mutates `vault.fileMap` chunk by chunk and yields between
    // chunks, so a failure partway leaves entries in the model. Everything
    // that later repairs a restored entry is gated on `snapshotFiles`: the
    // post-connect re-index of notes with no metadata, and the stat zeroing
    // that is the only thing correcting a restored stat on an SFTP session.
    // Recorded after the insert, a partial restore left stale entries that
    // nothing would ever reconcile.
    const { internal, app } = makePlugin({
      entries: [entry('notes', true), entry('notes/a.md'), entry('b.md')],
    });
    const knownAtFirstInsert: Array<string[] | null> = [];
    (app.vault as unknown as { trigger: (...a: unknown[]) => void }).trigger = () => {
      knownAtFirstInsert.push(internal.snapshotFiles ? [...internal.snapshotFiles].sort() : null);
    };

    await internal.restoreTreeSnapshot();

    expect(knownAtFirstInsert[0], 'the repair list must exist before the first insert')
      .toEqual(['b.md', 'notes/a.md']);
  });

  it('drops entries the current settings no longer allow', async () => {
    // The snapshot was captured under last session's rules; a folder the user
    // has since ignored must not come back at every launch.
    const { internal, fileMap } = makePlugin({
      entries: [entry('keep.md'), entry('node_modules', true), entry('node_modules/x.md')],
    });

    await internal.restoreTreeSnapshot();

    expect(Object.keys(fileMap)).toEqual(['keep.md']);
    expect([...internal.snapshotFiles ?? []]).toEqual(['keep.md']);
  });

  it('does nothing without a snapshot, and leaves the model empty', async () => {
    const { internal, fileMap } = makePlugin({ entries: [] });

    await internal.restoreTreeSnapshot();

    expect(Object.keys(fileMap)).toEqual([]);
    expect(internal.snapshotFiles).toBeNull();
  });
});
