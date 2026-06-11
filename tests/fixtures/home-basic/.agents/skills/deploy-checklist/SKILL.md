---
name: deploy-checklist
description: Run through the pre-deploy checklist covering tests, migrations, feature flags, and rollback plans. Use before any production deployment.
---

# Deploy Checklist

Before deploying:

1. All tests green in CI.
2. Database migrations are reversible.
3. Feature flags default to off.
4. Rollback command documented in the runbook.
