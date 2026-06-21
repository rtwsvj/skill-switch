---
name: malformed-tags
description: Use when testing that a non-array tags field triggers a warning.
tags: "git, ci"
---

# Malformed Tags

This skill sets `tags` as a comma-separated string instead of a YAML list.
It should trigger a convention/tags-not-array warning.
