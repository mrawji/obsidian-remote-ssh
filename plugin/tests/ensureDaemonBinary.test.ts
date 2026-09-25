import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// main.ts pulls in RemoteTerminalView (extends the obsidian ItemView the unit
// mock doesn't model) — stub it so the import graph resolves. Same shim the
// sibling connectProfile.daemon-downgrade.test.ts uses.
vi.mock('../src/ui/RemoteTerminalView', () => ({
  RemoteTerminalView: class {},
  VIEW_TYPE_REMOTE_TERMINAL: 'remote-terminal',
}));

import { App } from 'obsidian';
import RemoteSshPlugin from '../src/main';

/** A fake SftpClient whose `exec` answers the daemon's `uname` probe. */
const linuxAmd64Client = {
  exec: async (cmd: string) => ({
    stdout: cmd === 'uname -s' ? 'Linux' : 'x86_64',
    stderr: '',
    exitCode: 0,
  }),
};

const tmpDirs: string[] = [];
function scratchPluginDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rs-daemon-${process.pid}-`));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'server-bin'), { recursive: true });
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    try { fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const BIN_NAME = 'obsidian-remote-server-linux-amd64';

describe('RemoteSshPlugin.locateDaemonBinary — .dev-daemon marker gate', () => {
  it('returns null for an UNMARKED staged binary (a download must not masquerade as a dev build)', () => {
    const plugin = new RemoteSshPlugin(new App() as never);
    const dir = scratchPluginDir();
    fs.writeFileSync(path.join(dir, 'server-bin', BIN_NAME), 'ELF');
    const p = plugin as unknown as { pluginDir: () => string; locateDaemonBinary: () => string | null };
    p.pluginDir = () => dir;

    expect(p.locateDaemonBinary()).toBeNull();
  });

  it('returns the binary path once dev-install has written the .dev-daemon marker', () => {
    const plugin = new RemoteSshPlugin(new App() as never);
    const dir = scratchPluginDir();
    const bin = path.join(dir, 'server-bin', BIN_NAME);
    fs.writeFileSync(bin, 'ELF');
    fs.writeFileSync(path.join(dir, 'server-bin', '.dev-daemon'), '');
    const p = plugin as unknown as { pluginDir: () => string; locateDaemonBinary: () => string | null };
    p.pluginDir = () => dir;

    expect(p.locateDaemonBinary()).toBe(bin);
  });
});

// The `ensureDaemonBinary` cases moved to `ensureDaemonBinary.module.test.ts`
// when the function left `main.ts`. They assert the same things, against the
// module, without constructing a plugin to reach them.
