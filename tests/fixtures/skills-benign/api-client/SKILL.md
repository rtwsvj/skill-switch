---
name: api-client
description: Guide making authenticated API calls using environment variables for secrets. Use when integrating a third-party REST API.
---

# API Client

Keep secrets in the environment, never hardcode them. Send requests to your own
configured base URL:

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" "$API_BASE_URL/v1/users"
```

Store `API_TOKEN` and `API_BASE_URL` in your shell profile or a local `.env`
that is gitignored. The token only goes to your own configured host.
