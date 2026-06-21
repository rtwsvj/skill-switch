---
name: malformed-triggers
description: Use when testing that a triggers field with mixed-type items triggers a warning.
triggers:
  - use when asked about deploys
  - 42
---

# Malformed Triggers

This skill sets `triggers` as an array with a non-string item.
It should trigger a convention/triggers-invalid-type warning.
