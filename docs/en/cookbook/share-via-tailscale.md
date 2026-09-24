---
title: Share a vault via Tailscale
tags: [cookbook, how-to, tailscale]
description: "Run obsidian-remote-ssh over Tailscale: zero router config, encrypted in-transit traffic, works across NAT, reachable from your laptop and (later) your phone."
schema: Article
---

# Share a vault via Tailscale

Goal: a vault on a home Pi (or NAS, VPS) that you and a collaborator both edit from your respective laptops, with no port forwarding and no third-party cloud.

## Why Tailscale

The plugin needs SSH reachability to the host. The default options:

| Approach | Setup | Trade-offs |
|---|---|---|
| Port-forward 22 on your home router | High effort, security-sensitive | Exposes sshd to the public internet |
| Cloudflare Tunnel | Medium effort | Requires CF account + a domain |
| **Tailscale** | Low effort | One install per device, mesh VPN; no public exposure |

For "two laptops + one home server" sharing, Tailscale is the lowest-friction path.

## On the host

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

The `up` command shows a one-time auth URL. Open it, sign into your tailnet (or create one). When the host appears in your tailnet, note its Tailscale IP and MagicDNS hostname:

```bash
tailscale ip -4
# 100.64.0.1

tailscale status | head -3
# 100.64.0.1   obsidian-vault   you@example.com   linux  -
# 100.64.0.2   laptop           you@example.com   macOS  active

# MagicDNS hostnames look like:
#   obsidian-vault.<your-tailnet>.ts.net
# Find your tailnet name in the Tailscale admin console.
```

## On each editor's laptop

Install Tailscale (macOS / Windows / Linux installers at [tailscale.com](https://tailscale.com/download)). Sign into the same tailnet.

## Plugin profile

For each editor, in the plugin:

| Field | Value |
|---|---|
| Host | `obsidian-vault.tailnet-XXXX.ts.net` (or the `100.x.y.z` IP) |
| Port | `22` |
| Username | `pi` (or whatever your remote user is) |
| Authentication | SSH agent (recommended) |
| Remote vault path | `/home/pi/notes` |

That's it — no jump host needed. Tailscale provides the path; the plugin sees a normal SSH host.

## Multi-editor caveats

Two people editing the same file at the same time = a conflict. The plugin detects + offers resolution (see [[en/user-guide/conflicts|Conflict handling]]) but you'll want to talk to your collaborator about who owns which area of the vault.

The plugin's per-client `Client ID` keeps your workspace state (open tabs, panes, cursor position) from stomping on each other; see [[en/configuration/this-device|Configuration → This device]].

## ACL hardening (optional)

Tailscale's default policy lets every device in the tailnet reach every other on every port. Lock down to "only laptops can SSH to the vault host" in the [Tailscale ACL editor](https://login.tailscale.com/admin/acls).

```hujson
{
  "groups": {
    "group:editors": ["alice@example.com", "bob@example.com"],
  },
  "tagOwners": {
    "tag:obsidian-vault": ["group:editors"],
  },
  "acls": [
    { "action": "accept", "src": ["group:editors"], "dst": ["tag:obsidian-vault:22"] },
  ],
}
```

Then re-tag the host:
```bash
sudo tailscale up --advertise-tags=tag:obsidian-vault
```

## Is this actually tested?

Yes. The integration suite runs a second time on every PR against an sshd
that publishes no port at all and is reachable only across a private
WireGuard mesh, addressed by its MagicDNS name — the "SSH integration
(tailnet)" job. So "the plugin needs no special handling" is not a claim
about one connection; it is the whole suite passing over that path. See
[Testing strategy → Test environments](../contributing/testing-strategy.md).

## If you enable Tailscale SSH

`tailscale up --ssh` is a different thing from the setup above. It makes
`tailscaled` *itself* answer port 22 for tailnet traffic, taking your
identity from the WireGuard peer and checking it against the tailnet's SSH
policy. Your own `sshd` is bypassed for connections arriving over the
tailnet.

The plugin still works. Point a profile at the host as usual and leave
`Authentication` on `Private key`: Tailscale SSH accepts the connection
without looking at the key, and serves SFTP.

That was measured, not assumed — against `tailscale up --ssh` on Tailscale
**1.102.4**, with a key the server had never seen: it authenticated and SFTP
round-tripped. It is one observation on one version, and this path is not in
CI, so treat it as "known to have worked" rather than a guarantee.

Two caveats, both upstream and both worth knowing before you switch:

- **A chatty login banner can corrupt file transfers.** Tailscale SSH serves
  SFTP inside a login shell, so anything your `/etc/motd` or shell rc prints
  lands in the SFTP stream
  ([tailscale#12452](https://github.com/tailscale/tailscale/issues/12452)).
  Create an empty `~/.hushlogin` on the remote, or keep the MOTD quiet.
- **File permissions are not applied at creation**
  ([tailscale#5735](https://github.com/tailscale/tailscale/issues/5735)).
  Harmless for notes; relevant if you keep scripts in the vault.

Unlike the setup above, this path is not covered by CI. If you would rather
avoid both caveats, leave Tailscale SSH off and let the plugin talk to your
ordinary `sshd`, which is what the rest of this page describes.

## See also

- [[en/user-guide/jump-host|User guide → Jump hosts]] — for cases where Tailscale isn't an option
- [[en/security/model|Security → Threat model]] — what the plugin defends against (Tailscale stacks neatly under it)
