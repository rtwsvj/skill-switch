# Architecture Overview

This document is a contributor-oriented overview of how skill-switch is structured internally. It is intentionally concise — read the source alongside it.

---

## High-level picture

```
┌─────────────────────────────────────────────────────────┐
│  GUI (Tauri v2 + React)                                  │
│  gui/src-tauri/  +  gui/src/                             │
│  Invokes CLI via a bundled Node SEA sidecar              │
└────────────────────────┬────────────────────────────────┘
                         │ subprocess / shell-out
┌────────────────────────▼────────────────────────────────┐
│  CLI layer   src/cli/                                    │
│  Commander-based commands (one file per sub-command)     │
│  Parses flags, formats output, sets exit code            │
└────────────────────────┬────────────────────────────────┘
                         │ imports
┌────────────────────────▼────────────────────────────────┐
│  Core modules   src/core/                                │
│  Pure logic — no CLI concerns, injected `home` root      │
└────────────────────────┬────────────────────────────────┘
                         │ imports (read-only vendor snapshot)
┌────────────────────────▼────────────────────────────────┐
│  Vendored snapshots   src/vendor/                        │
│  vercel-labs/skills + Karanjot786/agent-skills-cli       │
│  Kept verbatim; local patches annotated in-file          │
└─────────────────────────────────────────────────────────┘

Runtime data:  ~/.skill-switch/   (skills.json / skills.lock.json / backups/ / store/)
Agent dirs:    ~/.claude/skills/  ~/.codex/skills/  etc.
Audit rules:   rules/             (top-level, one file per rule family)
```

---

## Core modules (`src/core/`)

Each module is a focused, testable unit. The CLI layer imports from here; the GUI does so indirectly via the CLI sidecar.

| Module | Role |
|---|---|
| `scan.ts` | Read-only: walks each supported agent's skills directory, reads `SKILL.md` frontmatter, and returns a unified `SkillRecord[]`. Deduplicates directories that are shared across agents (the universal `.agents/skills/` convention). |
| `sync.ts` | Owns the `SkillsDeclarationFile` type (`skills.json`), the `planSync` / `applySync` functions, and read/write helpers (`readDeclaration`, `upsertSkillDeclarations`, `removeFromDeclaration`). The plan step computes `SyncAction[]` (create / replace / remove / noop); the apply step executes them. Codex is a special case: its disable/enable goes through `config.toml` rather than removing files. |
| `lock.ts` | Owns `SkillsLockFile` (`skills.lock.json`) with per-entry `sha256` content hash, source type, git commit, and install mode. Provides idempotent `upsertLockEntries` / `removeLockEntries`. |
| `audit/engine.ts` | Rule-execution core: iterates targets line-by-line, applies NFKC normalization + Cyrillic homoglyph mapping before matching, and runs both per-line rules and whole-file rules. Returns `findings[]`, `score`, and `verdict`. |
| `audit/score.ts` | Pure scoring function: `Score = 100 − (CRITICAL×20 + HIGH×10 + MEDIUM×3 + LOW×1)`. Verdict bands: SAFE ≥ 90, REVIEW 70–89, DANGER < 70. ≥5 CRITICALs → score 0. |
| `audit/config-discovery.ts` | Discovers and audits known agent config files for secrets and dangerous MCP server patterns. Covers: `~/.claude/settings.json`, `~/.claude/settings.local.json`, `~/.claude/claude_desktop_config.json`, `~/.claude/mcp.json`, `~/.mcp.json` (user-level), `~/.gemini/settings.json` (Gemini CLI), `~/.cursor/mcp.json` (Cursor), `~/.vscode/mcp.json` (VS Code), `~/.codeium/windsurf/mcp_config.json` (Windsurf), `~/.config/zed/settings.json` (Zed AI). Invoked by `audit --configs` and (advisory-only) by `doctor`. |
| `audit/mcp-audit.ts` | Audits MCP server config JSON: detects `curl \| sh`, reverse-shell patterns, unpinned `npx`/`uvx`/`bunx`, hardcoded secrets in env values, `LD_PRELOAD`/`DYLD_INSERT_LIBRARIES` injection, remote URL as command, command in world-writable temp directory, prompt-injection phrases in server metadata, invisible Unicode in metadata, and credential-path access (`mcp/credential-path-access`, medium: flags `command`/`args`/`env` values pointing at `~/.ssh`, `~/.aws`, `~/.gnupg`, `.netrc`, `~/.config/gh`, `~/.docker/config.json`, `~/.kube/config`, `~/.npmrc`). |
| `audit/settings-audit.ts` | Audits `settings.json` for hardcoded secret values in known sensitive keys. |
| `lint/` | Three sub-modules: `skills-json-validator.ts` validates `skills.json` structure; `spec-validator.ts` checks individual skill SKILL.md frontmatter; `portability.ts` emits cross-tool portability warnings; `lint-home.ts` combines them with conflict/budget health checks (via vendored `conflict-detector.ts` + `context-budget.ts`). |
| `doctor.ts` | Three-way reconciliation: declared (`skills.json`) × locked (`skills.lock.json`) × disk. Produces four drift kinds: `missing`, `content-drift`, `stale-lock`, `extra-locked`. Uses a hash cache (`doctor-hash-cache.ts`) to avoid redundant SHA-256 recomputation. Also reports bypasses (forced installs) and legacy skill names. Additionally runs `auditConfigFiles` and returns results as `configAudit` in the report (advisory only — does not affect the `clean` flag or exit code; `--json` output includes the full `configAudit` array). |
| `diff.ts` | Content drift detail for copy-mode skills: compares the disk copy against the `store/` reference, producing a `SkillFileDiff[]` (added / removed / modified). Includes an LCS-based unified-diff generator with no external dependencies. |
| `drift.ts` | Upstream drift: for git-sourced skills, compares `lock.commit` against the upstream `HEAD` via `git ls-remote`. Also checks local content hash against the lock. Produces `DriftEntry[]` with state `in-sync | upstream-ahead | local-modified | diverged`. |
| `backup.ts` | Snapshot primitive: `snapshot(dir, {store, label})` creates a timestamped `.tar.gz` archive (using system `tar`). `restoreSnapshot` validates the archive for path-traversal attacks before extracting into a staging directory and atomically renaming into place. |
| `install.ts` | Install orchestration: discovers skill directories (by `SKILL.md` presence), runs audit, takes a pre-install snapshot, copies or symlinks files, writes lock and declaration. Force-install records bypasses in the bypass ledger. |
| `remove.ts` | Consistent teardown: removes the disk skill directory, lock entry, and declaration entry in one operation. |
| `watch.ts` | Single-pass scan vs. declaration comparison: identifies skills present on disk but absent from `skills.json` (regardless of enabled state) and marks them `unmanaged`. |
| `state-io.ts` | Shared IO primitives for state files: `readJsonState` distinguishes ENOENT (returns fallback) from corruption (throws `StateFileError`). `writeJsonState` writes via a temp file + fsync + atomic rename, so the target is never left half-written. |
| `safe-copy.ts` | Recursive directory copy that silently skips symbolic links at every level — used by install and sync to prevent symlink-following during copy-mode installs. |
| `paths.ts` | Single source of truth for path resolution. Derives each supported agent's skills directory relative to `home` from the vendored `agents.ts` snapshot. The `--home <dir>` flag is threaded through here so that all commands can operate on a throwaway directory instead of the real home. |
| `bypass-ledger.ts` | Append-only log of installs that overrode the audit gate, including the findings bypassed, the reason supplied, and the CLI version. Surfaced by `doctor`. |
| `agent-snapshots.ts` | Allowlist of paths that `restore` is permitted to write into — guards against a malformed snapshot manifest pointing `sourceDir` at an arbitrary path like `~/.ssh`. |
| `stats.ts` / `stats-cache.ts` | Reads Claude Code transcript files to produce per-skill trigger counts and identifies dormant ("zombie") skills. |
| `codex-toggle.ts` | Codex-specific: reads and writes the `config.toml` `skills.disabled` array so that toggling a Codex skill uses its native mechanism rather than removing files. |
| `skill-name.ts` | Validation helpers: `isSafeSkillName` (no path traversal, no absolute paths, no hidden names) and `isCanonicalSkillName` (stricter: alphanumeric + `. _ -`, starts with alphanumeric, max 80 chars). |
| `git-safe.ts` | Validates git source URLs before clone: rejects local-file paths (`file://`, bare paths) and other non-http(s) transports to prevent unintended local reads. |

---

## CLI layer (`src/cli/`)

`src/cli/program.ts` creates the Commander root program with the global `--home` option. Each file in `src/cli/commands/` registers one sub-command via a `register*Command(program)` function; commands that target a specific agent (e.g. `install`, `remove`, `diff`) declare their own `--agent <agent>` option.

The CLI is the only layer that reads `--json`, formats human-readable tables, and sets `process.exitCode`. Core modules return typed objects; the CLI decides how to present them.

Exit code contract:
- Read-only commands (`scan`, `audit` without blocking findings, `lint`, `doctor` without `--ci`, `drift`, `stats`, `lock`) exit 0 as long as they produce a report.
- `audit` exits 1 on any `critical`/`high` finding or score < 70.
- `doctor --ci` exits 1 on any drift finding.
- `lock --verify` exits 1 when any locked entry is missing, unknown, or hash-mismatched.
- All commands print `错误: <message>` to stderr and exit 1 on unexpected errors (no stack trace in production).

---

## GUI (`gui/`)

The GUI is a **Tauri v2** application with a **React** frontend.

- `gui/src/` — React source: `App.tsx` is the root component; views are organized under `components/`. State is React local state; data is fetched lazily (core dashboard on load; audit and stats only when the user navigates to those views).
- `gui/src-tauri/` — Rust Tauri shell. The Tauri layer handles the macOS app bundle, window management, and the CSP (Content Security Policy) that restricts the WebView's network access to `ipc:` only.
- **CLI sidecar**: the GUI never calls core TypeScript modules directly. Instead it shells out to `skill-switch-cli`, which is bundled as a **Node Single Executable Application (SEA)** sidecar at `gui/src-tauri/bin/skill-switch-cli-<triple>`. The SEA is built by `gui/scripts/bundle-cli.mjs` using esbuild (to produce a single CJS bundle) + Node's `--experimental-sea-config` + `postject`. The App therefore does not require a system `node` to run.
- `gui/fixtures/` — JSON fixtures used by GUI unit tests (vitest + React Testing Library) to exercise components without running the real CLI.

---

## Vendored snapshots (`src/vendor/`)

Two upstream projects are snapshotted verbatim (or with minimal annotated patches) rather than installed as npm dependencies. This keeps the project free of supply-chain risk from packages that could change unexpectedly.

**`src/vendor/vercel-skills/`** — from `vercel-labs/skills` (commit `be0dd25`):
- `agents.ts` — directory-mapping table for 71+ agents; the source of truth for where each tool keeps its skills.
- `types.ts` — `AgentType`, `AgentConfig`, `Skill` type definitions.
- `git.ts` — shallow git clone with ref support; used by `install` for git-sourced skills.
- `source-parser.ts` — parses GitHub shorthand, owner/repo, and subpath formats.
- `local-lock.ts` — `computeSkillFolderHash`: SHA-256 of the sorted file tree, used for content integrity.
- Local patches: `git.ts` has four compatibility fixes for `simple-git` 3.36; `source-parser.ts` has one security hardening (unsafe subpath degrades gracefully). All patches are annotated in-file.

**`src/vendor/agent-skills-cli/`** — from `Karanjot786/agent-skills-cli` (commit `956140b`):
- `conflict-detector.ts` — conflicting-instruction and topic-overlap heuristics, used by `lint` for budget health.
- `context-budget.ts` — token estimation and budget-constrained skill selection, used by `lint`.
- `skill-lock.ts` — design reference for the `commit`-as-version lock entry field (merged into `skills.lock.json` schema).
- No local patches.

---

## Data model

Three representations of what skills are installed:

```
skills.json          skills.lock.json        Disk
(declared)           (locked)                (actual)
─────────────        ────────────────────    ──────────────────────
name                 name + agent            <agent-skills-dir>/<name>/
agents[]             source, sourceType      SKILL.md + other files
enabled              ref, commit (git)
mode                 sha256                  (computed on demand)
source               mode
```

`doctor` performs the three-way reconciliation and reports drift kinds when these representations diverge. `lock --verify` re-hashes disk and checks it against `skills.lock.json` independently.

The **store** (`~/.skill-switch/store/<agent>/<name>/`) is a durable copy maintained only for `copy`-mode skills. It is the reference used by `sync` (to restore from) and `diff` (to compare against disk).

---

## Standard write-command flow

All commands that modify agent skill directories follow this sequence:

```
1. Validate inputs (skill name safety, source existence, agent known)
2. Run audit (for install) or read declaration (for sync/toggle/remove)
3. Take a pre-operation snapshot → ~/.skill-switch/backups/<ts>__<label>.tar.gz
4. Apply the change (copy / symlink / remove files; update config.toml for Codex)
5. Update skills.lock.json (upsert or remove entries)
6. Update skills.json declaration (upsert or remove skill)
7. Return result (installed paths, snapshot path, lock path)
```

Step 3 guarantees that every write is reversible via `restore`. Steps 5 and 6 keep the three representations (declared × locked × disk) consistent after every operation.

---

## Audit rules (`rules/`)

Each file exports one or more `AuditRule` or `AuditFileRule` objects. They are collected by `rules/index.ts` and passed to `audit/engine.ts`.

| File | What it catches |
|---|---|
| `reverse-shell.ts` | `/dev/tcp`, `nc -e`, `bash -i`, Python socket shells |
| `exfiltration.ts` | `curl`/`wget` sending env vars or sensitive files to external hosts |
| `credential-theft.ts` | Prompts asking for API keys, tokens, or passwords |
| `prompt-injection.ts` | Hidden instructions targeting the agent itself |
| `base64-payload.ts` | `base64 -d \| sh` and `atob()` → execute patterns |
| `staged.ts` / `staged-exfil.ts` | Two-step patterns: download + execute, or read + exfiltrate |
| `supply-chain.ts` | Unpinned `npx`/`uvx`/`bunx`, `curl \| sh` installer; `--registry`/`--index-url` pointing at plaintext-HTTP / raw-IP / reserved-TLD / paste-domain registries (`supply-chain/unofficial-registry`, severity medium; enterprise HTTPS registries not flagged) |
| `destructive.ts` | `rm -rf /`, `dd if=/dev/zero` |
| `persistence.ts` | Launchd plist writes, crontab edits, startup script injection |
| `global-tamper.ts` | Writes to `~/.bashrc`, `~/.zshrc`, `~/.gitconfig` |
| `ansi-injection.ts` | Raw ESC bytes (terminal title manipulation, prompt injection via ANSI) |
| `invisible-chars.ts` | Tag characters, deprecated bidi controls, invisible math operators |
| `clickfix.ts` | Social-engineering clipboard injection (`Run this in your terminal`) |

Known limitations (documented misses) are in [docs/known-limitations.md](known-limitations.md).
