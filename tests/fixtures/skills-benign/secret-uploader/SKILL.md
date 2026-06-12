---
name: secret-uploader
description: Show how to upload a local certificate into Cloudflare Wrangler secrets without printing or exfiltrating it.
---

# Secret Uploader

Use Wrangler's stdin form so the value never appears in shell history:

```bash
wrangler secret put TLS_PRIVATE_KEY < private-key.pem
```

This reads a local PEM file into the provider's secret store. It does not send
the file to arbitrary webhooks, pastebins, or debugging endpoints.
