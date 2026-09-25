import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The order below is the whole point, and until this file nothing enforced
 * it. It lived in `main.ts`'s `runAutoConnect`, which is excluded from the
 * coverage report, so the several long comments explaining *why* each step
 * sits where it does were the only thing holding it in place.
 */

const calls: string[] = [];
const record = (name: string, ret?: unknown) => (...args: unknown[]) => {
  calls.push(name);
  void args;
  return Promise.resolve(ret);
};

const pullShared = vi.fn();
const pushShared = vi.fn();
const pullPlugins = vi.fn();
const pushPlugins = vi.fn();
const pullBinaries = vi.fn();
const pushBinaries = vi.fn();

vi.mock('../src/shadow/SharedObsidianConfigSync', () => ({
  SHARED_OBSIDIAN_CONFIG_FILES: ['app.json', 'appearance.json'],
  pullSharedObsidianConfig: (...a: unknown[]) => pullShared(...a),
  pushSharedObsidianConfig: (...a: unknown[]) => pushShared(...a),
}));
vi.mock('../src/shadow/CommunityPluginsSync', () => ({
  communityPluginsBasePath: (root: string, id: string) => `${root}/state/${id}/base.json`,
  pullCommunityPlugins: (...a: unknown[]) => pullPlugins(...a),
  pushCommunityPlugins: (...a: unknown[]) => pushPlugins(...a),
  pullPluginBinaries: (...a: unknown[]) => pullBinaries(...a),
  pushPluginBinaries: (...a: unknown[]) => pushBinaries(...a),
  readEnabledPluginIds: () => ['remote-ssh'],
}));

import { syncConfigAfterConnect, watcherPorts, type ConfigSyncPorts } from '../src/shadow/postConnectConfigSync';
import type { SharedConfigWatcher } from '../src/shadow/SharedConfigWatcher';

/** A watcher that only records what was done to it, and in what order. */
function fakeWatcher() {
  return {
    markSynced: vi.fn(() => { calls.push('markSynced'); }),
    start: vi.fn(() => { calls.push('watcher.start'); }),
    stop: vi.fn(),
  } as unknown as SharedConfigWatcher & {
    markSynced: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
  };
}

function ports(over: Partial<ConfigSyncPorts> = {}): ConfigSyncPorts {
  return {
    adapter: {} as ConfigSyncPorts['adapter'],
    remoteConfigDir: '.obsidian',
    localConfigDir,
    stateRoot: '/state-root',
    profileId: 'P-1',
    installMissingPlugins: record('installMissingPlugins') as () => Promise<void>,
    notify: (m: string) => { notices.push(m); },
    tag: 'layout-ready',
    makeWatcher: () => watcher,
    ...over,
  };
}

let notices: string[];
let watcher: ReturnType<typeof fakeWatcher>;
let localConfigDir: string;

beforeEach(() => {
  // A real dir with real files: the baseline step reads them through `fs`,
  // and an absent file is legitimately skipped — which is what made the
  // first version of this test assert against nothing.
  localConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-cfgsync-'));
  for (const f of ['app.json', 'appearance.json']) {
    fs.writeFileSync(path.join(localConfigDir, f), '{}');
  }
  calls.length = 0;
  notices = [];
  watcher = fakeWatcher();
  pullShared.mockImplementation(record('pullShared', { pulled: [], skipped: [], errored: [] }));
  pushShared.mockImplementation(record('pushShared', { pushed: [], skipped: [], errored: [] }));
  pullPlugins.mockImplementation(record('pullCommunityPlugins', { pulled: true, merged: [] }));
  pushPlugins.mockImplementation(record('pushCommunityPlugins', { pushed: true, merged: [] }));
  pullBinaries.mockImplementation(record('pullPluginBinaries'));
  pushBinaries.mockImplementation(record('pushPluginBinaries'));
});

afterEach(() => {
  try { fs.rmSync(localConfigDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('syncConfigAfterConnect — the order the comments insist on', () => {
  it('pulls, round-trips the list, installs, then round-trips the binaries', async () => {
    // Each position is load-bearing:
    //  - the installer runs AFTER the plugin-list pull, because a plugin the
    //    pull just enabled has no binary staged yet (#429b);
    //  - the binary round-trip runs AFTER the installer, so it only stages
    //    what is STILL missing — the BRAT / sideloaded ones the marketplace
    //    cannot fetch.
    await syncConfigAfterConnect(ports());

    expect(calls).toEqual([
      'pullShared',
      'pullCommunityPlugins',
      'pushCommunityPlugins',
      'installMissingPlugins',
      'pullPluginBinaries',
      'pushPluginBinaries',
      'markSynced',
      'markSynced',
      'watcher.start',
    ]);
  });

  it('baselines the pulled bytes BEFORE starting the watcher', async () => {
    // Otherwise the pull's own writes look like local edits and echo straight
    // back to the remote the moment the watcher comes up.
    await syncConfigAfterConnect(ports());

    const firstStart = calls.indexOf('watcher.start');
    const lastMark = calls.lastIndexOf('markSynced');
    expect(lastMark).toBeLessThan(firstStart);
    expect(watcher.markSynced).toHaveBeenCalledTimes(2); // one per allowlisted file
  });
});

describe('syncConfigAfterConnect — every step is best-effort', () => {
  it('carries on when the shared-config pull throws', async () => {
    // A connection is up and the vault still has to render.
    pullShared.mockImplementation(() => Promise.reject(new Error('ssh hiccup')));

    await syncConfigAfterConnect(ports());

    expect(calls).toContain('pullCommunityPlugins');
    expect(calls).toContain('watcher.start');
  });

  it('carries on when the plugin-list round-trip throws', async () => {
    pullPlugins.mockImplementation(() => Promise.reject(new Error('corrupt list')));

    await syncConfigAfterConnect(ports());

    expect(calls).toContain('installMissingPlugins');
    expect(calls).toContain('pullPluginBinaries');
  });

  it('carries on when the marketplace installer throws', async () => {
    await syncConfigAfterConnect(ports({
      installMissingPlugins: () => Promise.reject(new Error('registry down')),
    }));

    expect(calls).toContain('pullPluginBinaries');
    expect(calls).toContain('watcher.start');
  });

  it('tells the user which config files could not be pulled', async () => {
    // Without this the symptom is settings that silently do not update —
    // which is #342 itself.
    pullShared.mockImplementation(record('pullShared', {
      pulled: [], skipped: ['app.json'], errored: ['app.json'],
    }));

    await syncConfigAfterConnect(ports());

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('app.json');
  });

  it('stays quiet when nothing errored', async () => {
    await syncConfigAfterConnect(ports());
    expect(notices).toEqual([]);
  });
});

describe('watcherPorts — how the real watcher reaches disk and remote', () => {
  it('reads a local config file', () => {
    fs.writeFileSync(path.join(localConfigDir, 'app.json'), '{"theme":"obsidian"}');

    expect(watcherPorts(ports()).readLocal('app.json')).toBe('{"theme":"obsidian"}');
  });

  it('returns null for a file that is not there, rather than throwing', () => {
    // A fresh vault legitimately has none of these yet; throwing here would
    // take down the watcher on a perfectly normal vault.
    expect(watcherPorts(ports()).readLocal('nothing-here.json')).toBeNull();
  });

  it('pushes through the adapter when it flushes', async () => {
    await watcherPorts(ports()).flush();

    expect(pushShared).toHaveBeenCalledTimes(1);
  });

  it('names the files that could not be pushed', async () => {
    // Without this the user sees a settings change that silently never
    // reaches the remote — #342 from the other direction.
    pushShared.mockImplementation(record('pushShared', {
      pushed: [], skipped: [], errored: ['hotkeys.json', 'app.json'],
    }));

    await watcherPorts(ports()).flush();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('hotkeys.json');
    expect(notices[0]).toContain('app.json');
  });

  it('says nothing when the push was clean', async () => {
    await watcherPorts(ports()).flush();

    expect(notices).toEqual([]);
  });

  it('hands back a handle that closes the fs watch', () => {
    const handle = watcherPorts(ports()).watch(() => { /* not asserted here */ });

    expect(() => handle.close()).not.toThrow();
  });
});
