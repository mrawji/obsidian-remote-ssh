---
title: Vault size
tags: [user-guide, performance, limits]
description: "How big a remote vault this plugin handles: measured first-connect and restart times from 1,000 to 50,000 notes, why the first connect costs what it costs, and where the wall is."
---

# Vault size

Measured, not estimated. The numbers below come from
`plugin/e2e/scale.spec.ts`, run against a real Obsidian, a real SSH
daemon and generated vaults of a known shape (every note two folders
down, with frontmatter, tags and five `[[links]]` each).

## What to expect

| Vault | First connect | Every later start |
|---|---|---|
| 1,000 notes · 5 MB | ~1 min | ~15 s |
| 10,000 notes · 50 MB | ~8 min | ~15 s |
| 10,000 notes · 500 MB | ~15 min | ~15 s |
| 50,000 notes · 5 GB | **hangs Obsidian** | — |

"First connect" is the wait until links, graph, search and Dataview see
the **whole** vault. The file tree itself shows up in about 15 seconds
at every size — you can open and edit notes long before the number
above.

**Practical limit today: around 10,000 notes.** Beyond that the first
connect stops being something you can sit through — and it is not simply
slower. At 50,000 notes the plugin does not degrade gracefully: reads
that take 42 ms at 10,000 notes take **24 seconds**, thousands of them
fail, more bytes cross the wire than the vault contains, and after about
15 minutes the Obsidian window stops responding and does not recover.
Do not point this at a 50,000-note vault expecting a long wait; expect a
hung window. Why it collapses rather than slows is being investigated in
[#513](https://github.com/sotashimozono/obsidian-remote-ssh/issues/513).

## Why the first connect costs that

Obsidian builds its own index by reading every markdown file, one at a
time — it does not parallelise, and the plugin cannot make it. Each read
is a round trip to your remote, and inside Obsidian's renderer a round
trip costs about 40 ms no matter how fast the link is (measured
identically on a LAN and on a 40 ms WAN; the same call from plain
Node.js takes under 1 ms). 10,000 notes × ~42 ms is the ~8 minutes
above.

Two things do **not** matter:

- **Attachments.** Obsidian never reads images, PDFs or other binaries
  to index them. A vault with 4.5 GB of attachments beside 500 MB of
  markdown costs the same as one with the markdown alone.
- **Link speed**, mostly. The cost is round trips, not bandwidth.

## Why later starts are fast

Since 1.1.8 the plugin saves the vault's tree — paths, modification
times and sizes, never content — on this device, and restores it before
Obsidian starts. Obsidian then keeps the index it already had instead of
throwing it away, so a restart reads nothing at all: 10,000 notes go
from ~8 minutes and 10,001 reads to ~15 seconds and zero.

The snapshot is per device, lives outside every vault in
`~/.obsidian-remote/state/<profile>/tree-snapshot.json`, and is
reconciled against the remote after each connect — a note changed or
deleted elsewhere is picked up, and a stale snapshot costs a re-read of
what changed, never wrong content.

## If your vault is larger

There is no setting today that trades index completeness for speed: the
whole tree has to be in Obsidian's model for `[[links]]`, graph, search
and the quick switcher to work at all
([#519](https://github.com/sotashimozono/obsidian-remote-ssh/issues/519)).

What helps now:

- **Use the daemon (RPC) transport** rather than plain SFTP.
- **Ignore directories you don't need** in the profile's *Ignore
  directories* — a vault root shared with `node_modules`, `.venv` or
  build output is mostly noise, and pruning it server-side is the one
  lever that removes work rather than reordering it.
- **Leave the first connect running** and come back to it — up to about
  10,000 notes. The file tree is usable throughout; only the vault-wide
  features wait. Past that size this stops being true, see above.

Work on the first connect is tracked in
[#513](https://github.com/sotashimozono/obsidian-remote-ssh/issues/513).
