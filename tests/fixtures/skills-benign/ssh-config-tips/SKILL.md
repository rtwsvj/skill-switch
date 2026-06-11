---
name: ssh-config-tips
description: Explain how to organize your SSH config with host aliases and key settings. Use when the user asks about managing multiple SSH hosts.
---

# SSH Config Tips

Organize `~/.ssh/config` with per-host blocks:

```
Host work
  HostName git.work.example
  User git
  IdentitiesOnly yes
```

This skill only edits the config file's host aliases. It never reads or transmits
key material; generate keys yourself with `ssh-keygen` and keep private keys local.
