/**
 * What counts as a source file, shared by the unit and integration configs.
 *
 * Both upload into the same Codecov project, so they have to agree: an
 * integration report that included `src/main.ts` would move the project
 * number for a reason no unit run can account for.
 *
 * Thresholds deliberately stay with the unit config. The integration suite
 * exercises one slice of the tree on purpose, so a percentage over the
 * whole tree says nothing about whether it did its job.
 */
export const coverageScope = {
  provider: 'v8' as const,
  reporter: ['text', 'lcov'] as ('text' | 'lcov')[],
  include: ['src/**/*.ts'],
  // src/ui/** + src/settings/** are testable on the
  // tests/__mocks__/obsidian.ts runtime mock. Files below are
  // excluded only until they have a dedicated test suite — drop
  // entries from this list as the suites land, then bump the
  // global thresholds back up.
  exclude: [
    'src/main.ts',
    'src/ui/ConnectModal.ts',
    'src/ui/HostKeyMismatchModal.ts',
    'src/ui/KbdInteractiveModal.ts',
    'src/ui/LargeTransferBar.ts',
    'src/ui/PendingEditsBar.ts',
    'src/ui/PendingEditsModal.ts',
    'src/ui/PendingPluginsModal.ts',
    'src/ui/RemotePathBrowserModal.ts',
    // #149 — heavy xterm.js DOM rendering + ResizeObserver makes
    // jsdom unit tests impractical. Manual smoke against a real
    // Obsidian window covers this; RemoteShell has its own unit tests.
    'src/ui/RemoteTerminalView.ts',
    'src/ui/StatusBar.ts',
    'src/ui/ThreeWayMergeModal.ts',
    'src/ui/WriteConflictModal.ts',
    'src/settings/ProfileForm.ts',
  ],
};
