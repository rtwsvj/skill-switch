# Change record: deep audit remediation

## Scope and authorization

- User approved execution with `批准执行` after the pre-remediation report and plan.
- Baseline: `6aed1bc6bb7248b83f3137e736da7ab5186eefb8` on `auto/iteration`.
- Implementation head before this record: `3ae5f90` on
  `codex/audit-remediation-20260710`.
- Implementation diff through that head: 114 files, 6,682 insertions, 1,457 deletions.
- No remote push, PR, publish, tag, release upload, signing, notarization, or real-home
  mutation was authorized or performed.

## Claims and concrete changes

### Audit/security

- `src/core/audit/service.ts` now owns reusable scanning, coverage, home audit, and
  blocking decisions. `src/cli/commands/audit.ts` keeps command/presentation concerns.
- Audit coverage is explicit and fail-closed for oversize, count, depth, read,
  symlink, binary, and unclassified executable gaps.
- Registry/MCP HTTP performs manual bounded redirects, strips cross-origin secrets,
  rejects downgrade/private literals, and resolves every hop before fetch to reject
  private/special DNS answers.
- Output safety redacts secrets/userinfo/argv and neutralizes terminal controls.
- Restore rejects archive links and special members.
- YAML frontmatter uses strict YAML 1.2 core parsing with dangerous features disabled.
- Guided-fix originals are isolated outside the skill tree.
- Third-party Actions are pinned to immutable SHAs.

### State and rollback

- A per-home PID/nonce operation lock serializes all authority-bearing write flows.
- Toggle/remove have compensating rollback for tested intermediate errors.
- State file writes use UUID temp files, mandatory file fsync, atomic rename, and
  best-effort directory fsync.
- The remaining abrupt-death gap is documented; there is no claim of cross-file ACID.

### Performance and reliability

- Unified diff strips common regions, bounds exact LCS work, and uses coarse valid
  replacement hunks for large divergent middles.
- Tree comparison streams hashes and retains only changed contents.
- MCP server scans use bounded concurrency while preserving result order.
- Swift CLI execution concurrently drains pipes and has timeout, cancellation,
  output caps, escalation, and diagnostic sanitization.
- MCP stdio frames/pending work are bounded and protocol errors recover cleanly.

### Privacy, packaging, and documentation

- Stats cache v2 stores aggregate values only; MCP stats disables cache writes.
- Claude and Codex transcript consumers use their bound adapters.
- The npm contract is CLI-only; package/coverage tool versions are aligned.
- SEA embeds the package version and exposes registered MCP rule metadata without
  relying on source files or `import.meta`.
- macOS assembly rebuilds/selects the exact host triple and verifies binary and plist
  versions.
- READMEs, contributor guide, architecture, distribution, troubleshooting, and known
  limitations now distinguish verified behavior from planned/external channels.

## Commit ledger

| Commit | Purpose |
|---|---|
| `1c05055` | Record approved execution and rollback plan. |
| `7d686b3` | Add baseline-failing blind-spot regressions and pre-remediation evidence. |
| `2717c0a` | Bound LCS resource use and reject archive links/special members. |
| `1aa96d5` | Compensate failed toggle/remove operations. |
| `652f496` | Pass Action inputs as literal argv and pin the invoked package version. |
| `dfab461` | Add the home-scoped operation lock primitive. |
| `989292a` | Make incomplete audit coverage explicit and blocking. |
| `a782652` | Redact/sanitize output and manually revalidate redirects. |
| `a65baa1` | Enforce read-only MCP cache behavior and bounded framing/queueing. |
| `9e44871` | Add bounded-concurrency MCP scanning. |
| `34979db` | Validate diff refs and end git option parsing. |
| `4917e48` | Replace the vulnerable/permissive frontmatter parser. |
| `17d1ecb` | Bound and test native macOS CLI subprocess execution. |
| `7554d19` | Align Vitest/coverage and CLI-only package contracts. |
| `7b7ed60` | Integrate the operation lock across home mutations. |
| `1c7797e` | Route stats/cooccurrence through transcript adapters. |
| `ce10efa` | Harden atomic state persistence. |
| `4ac0144` | Stream diff comparison and load only changed contents. |
| `4e552b4` | Align release documentation and build selection with verified artifacts. |
| `c017d0b` | Override the vulnerable transitive `qs` release. |
| `35da4cf` | Extract/enforce the core audit service boundary. |
| `758f4ec` | Isolate guided-fix backups outside the skill tree. |
| `1408ac2` | Include rules and raise measured coverage floors. |
| `4679bae` | Reject private/special DNS answers before network fetches. |
| `fb32d8d` | Pin third-party Actions to full SHAs. |
| `7d343fb` | Remove the remaining lint diagnostics. |
| `3ae5f90` | Embed version metadata and make MCP rules resource SEA-safe. |

## Verification evidence

| Check | Result |
|---|---|
| Eight original blind-spot suites | Baseline 21 failed/5 passed; final 39/39 passed. |
| `pnpm test:coverage` | 162 files, 2,653 tests passed; thresholds passed. |
| Coverage | 69.77% statements, 64.67% branches, 73.57% functions, 70.77% lines. |
| `pnpm typecheck` | Passed. |
| `pnpm lint` | Passed with zero diagnostics. |
| `swift test` | 8/8 process tests passed. |
| `swift build` + i18n | Passed; 175 keys consistent across four locales. |
| Official-registry `pnpm audit --prod` and full audit | No known vulnerabilities. |
| Final npm tarball | 419,528 bytes; clean-prefix install/version/audit/MCP smoke passed. |
| SEA smoke from `/tmp` | Version 0.9.0, scan works, MCP rules returns 45 registered rules. |
| `macos/build-app.sh` | arm64 unsigned app built; 116 MiB; all version checks passed. |
| Large diff benchmark | 0.889 ms, 9.38 MiB heap, 64.03 MiB RSS under 192 MiB cap. |
| `git diff --check` | Passed during every repair batch and final review. |

Expected stderr from negative-path tests (invalid policy/baseline, refused restore,
existing workflow files) appeared during the full run and did not indicate failures.

## Rollback procedure and exercise

For one repair family, use `git revert <commit>` on a review branch and rerun the
focused tests listed by that commit. For the original state without rewriting history,
switch to `auto/iteration` or create a new branch at
`6aed1bc6bb7248b83f3137e736da7ab5186eefb8`.

Exercise performed:

1. Added a detached worktree at implementation commit `fb32d8d`.
2. Ran `git revert --no-edit fb32d8d...` inside only that worktree.
3. Git created clean revert commit `b38e64b28983110ef0a17c5ca1306eb0e7e3a9a8`.
4. Confirmed the main worktree stayed at `fb32d8d` during the exercise.
5. Removed the temporary worktree.

Do not use `git reset --hard` to undo these changes; the commit ledger is intentionally
structured for reviewable reverts.

## Explicit residuals

- No write-ahead journal for automatic recovery from `SIGKILL`/power loss.
- No connect-time socket pinning against DNS rebinding after the policy lookup.
- A single very large changed file is still buffered for unified diff output.
- Child-process CLI coverage is not merged into V8's parent report.
- Apple signing/notarization and external package-manager publication require external
  credentials/authority and remain unperformed.

See the post-remediation verification report for priority, impact, fix proposal, and
acceptance test for each residual.
