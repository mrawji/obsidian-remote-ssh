import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * `test-env/target.ts` decides which sshd the integration and E2E suites
 * talk to. Nothing else in the repo can catch it being wrong: if the default
 * ever stopped being `local`, every ordinary CI run would quietly start
 * aiming somewhere else, and the failure would arrive as a connection error
 * attributed to the plugin.
 *
 * The module reads `ORSSH_TEST_ENV` once, at import, so each case resets the
 * module registry and imports it again under a different environment.
 */

async function loadTarget(env?: string) {
  vi.resetModules();
  if (env === undefined) delete process.env.ORSSH_TEST_ENV;
  else vi.stubEnv('ORSSH_TEST_ENV', env);
  return import('../test-env/target');
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('test-env/target', () => {
  it('defaults to the local environment when nothing asks for another', async () => {
    const t = await loadTarget(undefined);
    expect(t.TEST_ENV).toBe('local');
    expect(t.TEST_HOST).toBe('127.0.0.1');
    expect(t.TEST_PORT).toBe(2222);
  });

  it('gives the local environment a directly-dialled profile with no proxy', async () => {
    const t = await loadTarget('local');
    const conn = t.targetConnection();
    expect(conn).toEqual({ host: '127.0.0.1', port: 2222, connectTimeoutMs: 10_000 });
    expect('proxyCommand' in conn,
      'a `proxyCommand: undefined` key would still reach SshProfile and change behaviour')
      .toBe(false);
  });

  it('gives the tailnet environment a MagicDNS name and a proxy to reach it', async () => {
    const t = await loadTarget('tailnet');
    const conn = t.targetConnection();
    expect(conn.host).toBe('vault.tailnet.test');
    expect(conn.port).toBe(22);
    expect(conn.proxyCommand).toContain('socks5-connect.mjs');
    expect(conn.proxyCommand, 'ProxyCommandTunnel expands %h/%p against the target')
      .toContain('%h');
    expect(conn.connectTimeoutMs).toBeGreaterThan(10_000);
  });

  it('reports the capabilities callers branch on, rather than making them ask the name', async () => {
    const local = await loadTarget('local');
    expect(local.CAN_SHAPE_LINK, 'the local sshd has NET_ADMIN').toBe(true);
    expect(local.START_COMMAND).toBe('npm run sshd:start');

    const tailnet = await loadTarget('tailnet');
    expect(tailnet.CAN_SHAPE_LINK, 'the tailnet node does not').toBe(false);
    expect(tailnet.START_COMMAND).toBe('npm run tailnet:start');
    expect(tailnet.SSHD_CONTAINER).not.toBe(local.SSHD_CONTAINER);
  });

  it('drops sshd without taking the tailnet down with it', async () => {
    // The reconnect spec wants the server to go away while the path to it
    // stays up. Reaching for `tailnet:stop` would take headscale too, and a
    // node that loses its control connection over plain HTTP never comes
    // back — the environment would not survive the drop it is simulating.
    const t = await loadTarget('tailnet');
    expect(t.SSHD_STOP_COMMAND).toContain(t.SSHD_CONTAINER);
    expect(t.SSHD_STOP_COMMAND).not.toContain('tailnet:stop');
    expect(t.SSHD_START_COMMAND).toContain(t.SSHD_CONTAINER);

    // And the local environment keeps exactly what it always ran.
    const local = await loadTarget('local');
    expect(local.SSHD_STOP_COMMAND).toBe('npm run sshd:stop');
    expect(local.SSHD_START_COMMAND).toBe('npm run sshd:start');
  });

  it('refuses an unknown environment instead of quietly falling back', async () => {
    // Falling back to `local` here would be the worst outcome: a typo in a
    // CI job would run the suite against the wrong environment and pass.
    await expect(loadTarget('tailscale')).rejects.toThrow(/Unknown ORSSH_TEST_ENV/);
  });
});
