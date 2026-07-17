# Post-remediation deep engineering audit

## Executive status

- Baseline: `6aed1bc6bb7248b83f3137e736da7ab5186eefb8` (`auto/iteration`).
- Remediation head: `3ae5f90` (`codex/audit-remediation-20260710`).
- Scope: architecture, security, tests, performance, code quality, documentation,
  package/release behavior, native macOS bridge, and rollback evidence.
- Dynamic tests used temporary HOME/directories only. No real Agent state, remote
  publication, signing identity, or notarization service was used.
- Result: all reproduced P0 defects are closed by regression tests. Two P1 design
  boundaries remain explicit: multi-file crash recovery and connect-time DNS pinning.

## Priority-ordered findings

### P0 — resolved

| ID | File path(s) | Cause and impact | Remediation | Verification |
|---|---|---|---|---|
| P0-01 incomplete audit accepted as safe | `src/core/audit/service.ts`, `src/core/install.ts`, `src/core/safe-copy.ts` | Size/count/depth/read limits and top-level symlink behavior could produce zero or partial scanning while installation continued. Malicious content beyond a limit was copied into an Agent directory. | Added explicit coverage accounting, fail-closed reasons, content-based text classification, single top-level symlink handling, and install gating. Only omissions caused by the sanitized copy contract are accepted. | `p0-audit-incomplete-install-regression`, `p0-top-level-symlink-audit-seam`, `audit-coverage`, and symlink suites pass. The eight original blind-spot suites are now 39/39. |
| P0-02 Action expression-to-shell injection | `action.yml`, `scripts/github-action-audit.mjs` | Workflow inputs were interpolated into shell source and the default package was unpinned `latest`; a crafted input could change the executed command or pull mutable code. | Inputs now travel through environment/argv, a Node wrapper tokenizes allowed extra args, `spawnSync` runs with `shell:false`, and the default package version is exact. | `github-action-audit.test.ts` and `audit-blindspot-action-inputs.test.ts` pass. |
| P0-03 torn state and lost concurrent updates | `src/core/operation-lock.ts`, `install.ts`, `toggle.ts`, `remove.ts`, `sync.ts`, `doctor.ts`, CLI import/init/sync, `drift-approvals.ts` | Multi-file operations made decisions outside a common critical section; intermediate errors could change declarations or disk before later validation failed. Concurrent writers could overwrite each other's read-modify-write updates. | Added a per-home PID/nonce lock with stale-dead-process recovery and ownership-safe release. Public mutations now hold it across read/plan/snapshot/apply. Toggle/remove add tested compensation. | 16 focused files/207 tests plus 7 additional files/58 tests passed; process-level tests cover concurrent install/import/init/sync/APM/approval and lock release after failures. |
| P0-04 unsafe archive restore members | `src/core/backup.ts` | Tar path checks did not reject symlink/hardlink/special members, allowing archive semantics to escape the intended regular-file tree. | Restore lists names and verbose member types before swapping the target; only directories and regular files are accepted. | Backup, restore, and `audit-backup-link-blindspots.test.ts` pass. |
| P0-05 secrets/control bytes reached output | `src/core/security/output-safety.ts`, audit/settings/MCP formatters | Findings could echo literal secrets, argv credentials, URL userinfo, or ESC/OSC/C1 control bytes into logs and terminals. | Centralized redaction, argv/URL display safety, and control-character neutralization across human audit, guided-fix, settings, and MCP output. | `audit-blindspot-output-safety`, `output-safety`, settings, and MCP contract suites pass. |
| P0-06 redirect and hostname SSRF | `src/core/security/url-safety.ts`, `src/core/registry/fetch.ts`, `src/core/mcp-scan/client.ts` | Automatic redirects were not revalidated and credentials could cross origins. Literal/private targets and domain names resolving to private addresses could reach metadata or internal services. | Manual redirect loop (max 5), per-hop protocol/credential/origin policy, cross-origin secret stripping, literal-IP checks, and DNS `lookup(all=true)` before every fetch. Local HTTP remains restricted to explicit loopback MCP transport. | Redirect and DNS regression tests pass (50 focused network tests). Initial/redirect private DNS answers are rejected before fetch. |
| P0-07 MCP resource exhaustion and write side effect | `src/mcp/server.ts`, `src/core/stats.ts`, `src/core/stats-cache.ts` | Stdio framing and pending work were unbounded, malformed requests were weakly validated, and the advertised read-only stats tool could write a cache containing excessive session detail. | Added a 1 MiB frame limit, 64-request serial queue, JSON-RPC shape errors/recovery, aggregate-only cache v2, and MCP `cacheMode:disabled`. | MCP framing/read-only/cache suites pass; filesystem assertions confirm MCP stats writes nothing. |
| P0-08 unsafe frontmatter dependency | `src/core/frontmatter.ts`, scan/lint/spec consumers, `pnpm-lock.yaml` | The former parser dependency chain carried advisories and permissive YAML features (duplicates, custom tags, merges/prototype keys) expanded the attack surface. | Replaced it with the maintained `yaml` parser in YAML 1.2 core/strict mode; disabled merge/custom tags, bounded aliases, rejected duplicate/prototype keys, and updated vendored consumers. | Frontmatter security/fuzz/scan/lint tests pass. Both production and full official-registry dependency audits report no known vulnerabilities. |

### P1 — resolved or materially reduced

| ID | File path(s) | Cause and impact | Remediation | Verification |
|---|---|---|---|---|
| P1-01 quadratic unified diff | `src/core/skill-diff.ts` | Exact LCS allocated O(m×n) memory; a 5,000-line near-identical file aborted under a 192 MiB heap. Directory comparison also retained both full trees. | Strip common prefix/suffix; exact LCS only when the middle product is ≤250,000 cells, otherwise emit a deterministic replacement. Stream file hashes and load only changed contents. | Current 5,000-line benchmark: 0.889 ms algorithm time, 9.38 MiB heap, 64.03 MiB RSS, 143-byte patch; semantic golden tests pass. |
| P1-02 macOS CLI subprocess deadlock/hang | `macos/Sources/SkillSwitch/CLIRunner.swift`, `macos/Tests/.../CLIRunnerTests.swift` | Sequential pipe reads could deadlock on full stdout/stderr; no hard timeout/output cap/cancellation escalation existed; diagnostic controls were unsafe. | Concurrent drains, 64 KiB diagnostic caps, 16 MiB combined cap, 120 s timeout, Task cancellation, TERM→KILL, bounded drain, and C0/C1 sanitization. | Swift Testing: 8/8; `swift test`, debug/release `swift build`, and real `.app` assembly pass. |
| P1-03 guided-fix preserved malicious original inside skill | `src/core/audit/guided-fix.ts`, `src/cli/commands/audit.ts` | Adjacent `.skill-switch.bak` files remained Agent-readable and were re-scanned/re-fixed on the second run, breaking idempotence. | Original content moves to `HOME/.skill-switch/fix-backups/<target-hash>/...`, created exclusively with mode 0600 and never overwritten. | 66 guided-fix/scan tests pass; second apply modifies zero files and the backup path is outside the target tree. |
| P1-04 git ref option ambiguity/injection | `src/cli/commands/audit.ts` | `--diff-from` reached `git diff` without proving it was a commit or ending option parsing. | Verify with `rev-parse --verify --end-of-options <ref>^{commit}`, use the canonical hex, then call diff with `--end-of-options`. | Output-format/diff-from suite: 51 tests pass. |
| P1-05 transcript adapters ignored by consumers | `src/core/transcripts.ts`, `src/core/stats.ts`, `src/core/packs/cooccurrence.ts` | Stats/cooccurrence discovered adapters but parsed all files as Claude records, dropping Codex usage and risking inconsistent privacy semantics. | Carry the adapter with every discovered file and dispatch parsing through it; retain aggregate-only cache and per-session semantics. | 10 focused files/141 tests pass, including dual-adapter counts, windows, dedup, and secret-not-in-cache assertions. |
| P1-06 core imported CLI command implementation | `src/core/audit/service.ts`, `src/cli/commands/audit.ts`, `src/core/install.ts`, `src/core/add/preview.ts`, `src/mcp/server.ts` | Install/add/MCP depended on the CLI audit God module, inverting the intended dependency direction and making reuse/refactoring fragile. | Extracted scan/coverage/gating/home audit into a core service; CLI keeps presentation/exit behavior and compatibility re-exports. | Architecture boundary test scans `src/core` and `src/mcp`; 309 relevant tests pass and no relative CLI import remains. |
| P1-07 non-durable/colliding state temp files | `src/core/state-io.ts` | PID+millisecond temp names could collide; file fsync failure was swallowed; rename metadata was not flushed. | Random UUID temp names, mandatory file fsync, atomic rename, and best-effort directory fsync. | 32-writer collision regression plus state/operation-lock tests pass. |
| P1-08 release/package contract was not executable or truthful | `package.json`, `src/version.ts`, `scripts/bundle-cli.mjs`, `macos/build-app.sh`, READMEs, `docs/distribution.md`, packaging stubs | Package root exported raw TypeScript; build selected the first stale SEA sidecar; SEA version became `unknown` outside the repo; docs advertised unsigned/unproduced channels as signed releases. | Package is explicitly CLI-only; build selects/rebuilds the host triple and verifies architecture/version; version is statically embedded from `package.json`; planned package-manager manifests are non-installable metadata; docs distinguish unsigned preview and signed artifacts. | Final tarball installs and runs version/audit/MCP from `/tmp`; SEA tests run outside repo; real arm64 `.app` assembles at 116 MiB with package/CLI/Info.plist version 0.9.0. |
| P1-09 mutable GitHub Action dependencies | `action.yml`, `.github/workflows/ci.yml`, `.github/workflows/release.yml` | Major tags are mutable and can change without a repository diff. | Pinned checkout/setup-node/pnpm/codeql/release actions to current 40-character upstream SHAs with version comments. | `workflow-supply-chain.test.ts` rejects any future non-local Action not pinned to a SHA. |

### P2 — resolved hygiene and observability

| ID | File path(s) | Cause and impact | Remediation | Verification |
|---|---|---|---|---|
| P2-01 slow serial MCP scans | `src/core/mcp-scan/scan.ts` | S servers each taking T time yielded O(S×T) wall time. | Bounded concurrency (default 4, max 16) with stable output order and stop-on-failure assignment. | Concurrency tests prove peak bound/order; worst wall becomes approximately O(ceil(S/C)×T). |
| P2-02 incomplete/weak coverage gate | `vitest.config.ts`, `.github/workflows/ci.yml` | `rules/` was excluded, Vitest/coverage versions drifted, and CI ran the full suite twice while enforcing floors 8–12 points below reality. | Include `src` + `rules`, pin compatible Vitest packages, run coverage once as the full suite, and raise floors to 67/62/70/68. | Final coverage passes: 69.77/64.67/73.57/70.77; rules 95.16% statements; core 89.58%. |
| P2-03 derived stats cache retained raw context | `src/core/stats-cache.ts`, `src/core/stats.ts` | Legacy entries could include args/session paths and expand with transcript volume. | v2 aggregate-only schema; legacy cache is read/upgraded; MCP disables cache. | Cache regression tests assert secret, `args`, and `sessionFile` absence. |
| P2-04 stale docs and release guidance | `README.md`, `README.en.md`, `CONTRIBUTING.md`, `docs/architecture.md`, `docs/distribution.md`, `docs/troubleshooting.md`, `docs/known-limitations.md` | Development, deployment, rollback, signing, read-only, and support claims disagreed with the repository. | Rewrote current support matrix, state model, data flows, deployment/signing boundaries, and troubleshooting/recovery steps. | README and distribution contract tests pass; shell/Ruby/JSON syntax checks pass. |
| P2-05 residual lint diagnostics | `rules/taint.ts`, `src/cli/commands/completion.ts`, `src/core/audit/config-discovery.ts` | Five informational diagnostics added noise to the quality gate. | Removed useless raw strings and literal-key indirection without changing regex behavior. | Full Biome lint is clean with zero diagnostics; 88 focused tests pass. |

## Remaining prioritized work

These are not represented as completed fixes.

| Priority | File path(s) | Reason | Impact | Recommended fix | Verification method |
|---|---|---|---|---|---|
| P1 | `src/core/operation-lock.ts`, all multi-file mutation services | Cooperative locking and compensation do not survive `SIGKILL`/power loss between authoritative writes; there is no write-ahead journal. | Declaration, lock, store, and Agent disk may disagree after abrupt death. | Add a versioned transaction journal containing intent, pre-state hashes/copies, step markers, fsync, and deterministic replay/rollback on next lock acquisition. | Process-kill matrix after every mutation boundary; restart and assert byte-identical pre-state or committed post-state. |
| P1 | `src/core/security/url-safety.ts`, registry/MCP HTTP clients | The policy lookup and Node fetch connection lookup are separate. | A malicious authoritative DNS server may rebind after validation. | Use a custom Undici dispatcher/connector that pins the validated address through connect, or enforce an egress proxy/network sandbox. | Controlled DNS server returns public then private; assert the actual socket never reaches private space. |
| P1 external | `macos/sign-notarize.sh`, release assets, planned Homebrew/Scoop channels | Local code cannot create credentials, notarize, publish, or prove external assets. | Signed distribution and package-manager availability remain unverified. | Run documented signing/notarization and channel-specific clean-machine tests with authorized credentials, then attach checksums/evidence. | `codesign`, `spctl`, `stapler`, checksum, clean install/upgrade/uninstall, and actual Release asset inspection. |
| P2 | `src/core/skill-diff.ts` | Unified output still buffers the contents of a single changed file. | One exceptionally large changed file can create memory pressure even though tree comparison and LCS are bounded. | Add per-file output caps/binary detection and stream a summary or external diff for oversized files. | 100 MiB changed-file benchmark under a fixed heap; verify deterministic truncated/binary report. |
| P2 | `src/cli/commands/audit.ts` | Presentation, policy/baseline orchestration, seven formats, and command registration remain in a ~1,100-line module. | Review surface and change coupling remain high despite core extraction. | Split formatters and baseline/policy orchestration into CLI-only modules while preserving the core boundary. | Golden output tests for every format plus the architecture boundary test. |
| P2 | `vitest.config.ts`, subprocess-heavy CLI tests | Child processes are behaviorally tested but their V8 coverage is not merged into the parent report, making CLI command files appear artificially low. | Aggregate coverage can understate CLI behavior evidence and hide truly untested branches among instrumented-child gaps. | Propagate V8 coverage from child CLIs or add an in-process Commander harness for command actions. | Per-command coverage report plus unchanged end-to-end child-process tests. |

## Test and performance evidence

- Original blind-spot baseline: 21 failed, 5 passed across eight files.
- Post-remediation blind-spot run: 39 passed, 0 failed across the same eight files.
- Final full run: 162 files, 2,653 tests, all passed in 60.32 s.
- Coverage: statements 69.77%, branches 64.67%, functions 73.57%, lines 70.77%.
- Core: 89.58% statements / 82.81% branches / 92.10% functions / 90.75% lines.
- Rules: 95.16% statements / 90.90% branches / 100% functions / 95.03% lines.
- Swift: 8 process tests passed; Swift build and four-language i18n (175 keys) passed.
- Dependencies: official npm audit, production and full graph, both zero known vulnerabilities.
- Packaging: final tarball 419,528 bytes; clean-prefix install, version, audit, and MCP resource smoke passed.
- App: real unsigned arm64 build succeeded; 116 MiB; package/SEA/Info.plist all 0.9.0.
- Large diff before: process aborted under a 192 MiB heap. After: 0.889 ms,
  9.38 MiB heap, 64.03 MiB RSS, valid 143-byte patch.

## Rollback evidence

- Repairs are split into 27 logical commits after the baseline.
- A detached worktree was created at `fb32d8d`, then
  `git revert --no-edit fb32d8d...` created clean revert commit `b38e64b`.
- The main worktree stayed at the original head throughout; the temporary worktree was
  removed after verification.
- No push, publish, tag, signing, notarization, or real-home mutation was performed.
