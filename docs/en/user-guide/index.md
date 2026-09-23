---
title: User guide
tags: [user-guide]
---

# User guide

Feature-by-feature walkthroughs for things you'll use during normal day-to-day editing — once you're past the [[en/getting-started/install|install]] and [[en/getting-started/first-connect|first connect]] steps.

## Pages

| Page | What it covers |
|---|---|
| [[en/user-guide/ssh-config\|SSH config import]] | Auto-populate a profile from an existing `~/.ssh/config Host` block |
| [[en/user-guide/jump-host\|Jump hosts]] | Single jump-host config (multi-hop tracked separately) |
| [[en/user-guide/host-keys\|Host-key trust UI]] | The first-connect trust dialog + how to handle a changed host key |
| [[en/user-guide/conflicts\|Conflict handling]] | mtime-precondition writes, what happens when two clients race, **and the missing automatic backup-on-overwrite caveat** |
| [[en/user-guide/terminal-pane\|Terminal pane]] | The xterm.js panel for opening a shell on the remote host |
| [[en/user-guide/plugin-compatibility\|Plugin compatibility]] | Which Obsidian community plugins work cleanly + the known sharp edges (Dataview, Templater, Excalidraw…) |
| [[en/user-guide/vault-size\|Vault size]] | How big a remote vault this handles: measured first-connect and restart times, and where the wall is |

## Reading order

There's no required order. Read as you encounter the feature. The one page worth reading **before** you need it is **[[en/user-guide/conflicts|Conflict handling]]** — it documents an unforgiving UX surface (no automatic backup of the rejected side) that's better understood in advance than discovered mid-edit.

## See also

- [[en/configuration/profiles|Configuration → Profiles]] — every per-profile field documented (SSH config import populates this UI)
- [[en/security/host-keys|Security → Host-key trust]] — the security model behind the trust dialog
- [[en/operations/troubleshooting|Operations → Troubleshooting]] — when a feature isn't behaving
