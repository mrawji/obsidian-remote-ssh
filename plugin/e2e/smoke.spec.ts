import { test, expect } from '@playwright/test';
import {
  launchObsidian,
  connectAndOpenShadow,
  type ObsidianHandle,
} from './helpers/obsidian';
import { scaffoldTestVault, type ScaffoldResult } from './helpers/vault-scaffold';

/**
 * Obsidian E2E smoke tests — the bare-minimum correctness checks
 * that exercise a real Obsidian window connected to a remote vault
 * via the Docker test sshd.
 *
 * Prerequisites:
 *   - Obsidian installed (or OBSIDIAN_PATH set)
 *   - Docker test sshd running (`npm run sshd:start`)
 *   - Plugin built (`npm run build`)
 *   - Server built (`npm run build:server`)
 *
 * Run: `npx playwright test --config e2e/playwright.config.ts`
 */

let obsidian: ObsidianHandle;
let scaffold: ScaffoldResult;

test.beforeAll(async () => {
  scaffold = scaffoldTestVault();
  obsidian = await launchObsidian(scaffold.vaultPath);
});

test.afterAll(async () => {
  await obsidian?.cleanup();
  scaffold?.cleanup();
});

test.describe('Remote SSH E2E smoke', () => {
  test('1 — Obsidian window opens and loads the vault', async () => {
    const { page } = obsidian;

    // Obsidian's main workspace container should be present
    const workspace = page.locator('.workspace');
    await expect(workspace).toBeVisible({ timeout: 30_000 });
  });

  // 2 and 3 read Obsidian's registries instead of driving the UI. Since
  // Obsidian 1.13 Settings opens in its own window (no `.modal-container` on
  // this page), and under Xvfb a keystroke can go nowhere while the window is
  // painting. Test 4 still drives the command palette end to end.
  test('2 — plugin settings tab is registered', async () => {
    const tabIds = await obsidian.page.evaluate(() => {
      const app = (window as unknown as {
        app: { setting: { pluginTabs: Array<{ id: string }> } };
      }).app;
      return app.setting.pluginTabs.map((t) => t.id);
    });
    expect(tabIds).toContain('remote-ssh');
  });

  test('3 — Remote SSH commands are registered', async () => {
    const commandIds = await obsidian.page.evaluate(() => {
      const app = (window as unknown as {
        app: { commands: { commands: Record<string, unknown> } };
      }).app;
      return Object.keys(app.commands.commands);
    });
    expect(commandIds.filter((id) => id.startsWith('remote-ssh:')).length)
      .toBeGreaterThan(0);
  });

  test('4 — connect to remote vault via command palette', async () => {
    // connectAndOpenShadow drives palette → "Remote SSH: Connect" →
    // passphrase modal Connect button → kill original → relaunch on
    // the shadow vault path Obsidian registered. After it returns,
    // `obsidian` points at the SHADOW window (the only one where
    // the connected status bar + remote files actually appear).
    obsidian = await connectAndOpenShadow(obsidian, scaffold.vaultPath);

    // The shadow vault's status bar must report the live connection.
    // This is the assertion the previous test 4 was missing — it
    // relied on "any .notice is visible" which fired even on
    // connection FAILURES (the failure notice itself is a .notice).
    const statusBar = obsidian.page.locator('.status-bar');
    await expect(statusBar).toContainText('Remote SSH: Connected', {
      timeout: 30_000,
    });
  });

  test('5 — file explorer shows remote files after connect', async () => {
    // Test 4 left `obsidian` attached to the shadow vault. The
    // file explorer there should list the docker test sshd's
    // pre-seeded `remote_demo*.md` (5 files).
    const fileExplorer = obsidian.page.locator('.nav-files-container');
    await expect(fileExplorer).toBeVisible({ timeout: 10_000 });

    // Anchor on the actual remote filenames rather than just
    // "items > 0" — the previous count-only assertion passed on
    // any vault that had at least one local file, including the
    // scaffold's seeded local_demo*.md, and didn't actually verify
    // a remote sync had happened.
    for (const i of [1, 2, 3, 4, 5]) {
      await expect(
        obsidian.page.locator(`.nav-file-title[data-path$="remote_demo${i}.md"]`),
      ).toBeVisible({ timeout: 15_000 });
    }
  });
});
