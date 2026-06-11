---
name: git-helper
description: Help with git operations like rebase, cherry-pick, and resolving merge conflicts. Use when the user asks about git commands or version control workflows.
---

# Git Helper

When the user asks about git operations:

1. Prefer non-destructive commands; always show what will change before running it.
2. For rebase conflicts, explain each conflicted hunk before resolving.
3. Never force-push without explicit confirmation.
