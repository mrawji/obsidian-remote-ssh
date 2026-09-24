---
title: SSH config & keys
tags: [user-guide]
description: "How obsidian-remote-ssh resolves SSH credentials: ed25519/RSA key files, passphrase prompts, ssh-agent fallback, password auth, custom port and identity-only mode."
---

# SSH config & keys

obsidian-remote-ssh uses your existing SSH credentials (key files, agent) — it does not maintain its own keychain.

## Authentication methods

Picked per profile in **Settings** → **Profile** → **Authentication**:

| Method | Settings field | Use when |
|---|---|---|
| **Private key file** (default) | Private key path → `~/.ssh/id_ed25519` etc. | Most common; tilde-expanded at runtime |
| **SSH agent** | (no path needed) | You run `ssh-agent` (most macOS / WSL setups; OpenSSH on Windows via `ssh-agent` service); plugin asks the agent to sign |
| **Password** | (none stored) | Fallback when keys are not an option; plugin prompts for password each connect; never persisted |

Passphrase-protected keys: if your agent has the unlocked key, agent auth works transparently. Otherwise the plugin prompts for the passphrase per connect.

### Which agent identities the plugin can use

`ssh-rsa`, `ssh-dss`, `ecdsa-sha2-nistp256/384/521`, `ssh-ed25519` — and, since 1.1.9, **OpenSSH certificates** over any of them (`ssh-ed25519-cert-v01@openssh.com` and friends). That is the credential you get wherever a CA issues short-lived logins: Teleport, HashiCorp Vault, step-ca, Google OS Login. Nothing to configure — put the certificate in your agent as you would for `ssh`:

```bash
ssh-add ~/.ssh/id_ed25519      # picks up id_ed25519-cert.pub beside it
ssh-add -l                     # both the key and the certificate should be listed
```

On **Windows**, this applies to the OpenSSH agent (the `\\.\pipe\openssh-ssh-agent` named pipe). **Pageant and Cygwin agents keep going through the SSH library's own client**, which drops certificates — so a certificate held by Pageant still will not work. Use the OpenSSH agent if you need one.

**FIDO security keys** (`sk-ssh-ed25519@openssh.com`, `sk-ecdsa-sha2-nistp256@openssh.com`) are still **skipped** — the plugin's SSH library cannot parse them. An agent holding only those fails with "SSH authentication failed" while `ssh` on the same machine succeeds; the plugin names the skipped identities in that notice and in its log so you can tell it apart from a wrong username or a server-side rejection. Tracking issue: [#536](https://github.com/sotashimozono/obsidian-remote-ssh/issues/536).

## What the plugin reads from `~/.ssh/`

Currently:

- The key file you point at (`~/.ssh/id_ed25519`, `~/.ssh/id_rsa`, etc.) — supports `ed25519`, `rsa`, `ecdsa`.
- `ssh-agent` socket via `SSH_AUTH_SOCK` (Linux/macOS) or the OpenSSH agent service on Windows.
- `~/.ssh/config` — the profile form has an **Import from SSH config** dropdown that lists `Host` blocks and pre-fills the profile fields (host, port, user, identity file).
- NOT used: `~/.ssh/known_hosts`. The plugin manages its own — see [[en/security/host-keys|Host keys]].

## Known-host trust (TOFU)

First connection to a new host shows a host-key fingerprint dialog. Trusting writes the fingerprint into the plugin's own known-host store. On subsequent connects, the fingerprint is verified silently. A mismatch on a known host opens a [[en/security/host-keys|mismatch dialog]]. This is independent of `~/.ssh/known_hosts` to keep the plugin's trust scope explicit.

## Common setups

### macOS / Linux with `ssh-agent`
```bash
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519
```
In the plugin: pick `Authentication: SSH agent`. Done.

### Windows
```powershell
Get-Service ssh-agent | Set-Service -StartupType Automatic
Start-Service ssh-agent
ssh-add $HOME\.ssh\id_ed25519
```
Then pick `Authentication: SSH agent` in the plugin.

### Hardware key (YubiKey, Secure Enclave)
Anything `ssh-agent` can sign with works. Set up your hardware key with your normal SSH workflow first, then pick `SSH agent` in the plugin.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Permission denied (publickey)` | Wrong path / key not authorized on remote / agent does not have the key |
| `Connection timeout` | Network unreachable, or remote sshd is on a non-22 port — set Port explicitly |
| `Bad host key` | Remote host key changed; see [[en/security/host-keys\|mismatch flow]] |
| Plugin asks for password every connect, even with `SSH agent` | Agent is not running or `SSH_AUTH_SOCK` is not set in Obsidian's environment |

For deeper diagnostics: **Settings** → **Advanced** → **Debug logging** on, then re-connect and check the Obsidian developer console.

Next: [[en/user-guide/jump-host|Jump hosts]].
