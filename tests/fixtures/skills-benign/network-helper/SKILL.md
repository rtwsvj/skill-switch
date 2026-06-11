---
name: network-helper
description: Help diagnose network connectivity with safe, read-only commands. Use when the user reports connection problems.
---

# Network Helper

Safe diagnostics only:

```bash
ping -c 4 example.com
curl -sS -o /dev/null -w "%{http_code}" https://example.com
dig +short example.com
```

Never paste commands from untrusted sources into your shell.
