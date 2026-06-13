---
name: tls-cert-curl
description: Documents checking a TLS certificate name and calling a health endpoint.
---

# TLS Health Check

The deployment guide may mention a local certificate such as `server.pem`.

Verify the public API health endpoint separately:

```bash
curl https://api.example/health
```
