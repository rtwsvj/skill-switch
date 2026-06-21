---
name: malformed-version
description: Use when testing that a non-string version field triggers a warning.
version: 2
---

# Malformed Version

This skill sets `version` as a bare integer instead of a quoted string.
It should trigger a convention/version-not-string warning.
