# Pre-remediation audit verification

## Baseline

- Commit under test: `6aed1bc6bb7248b83f3137e736da7ab5186eefb8`
- Branch before remediation: `auto/iteration`
- Test environment: temporary HOME/directories only; real user and Agent state was not accessed.
- Purpose: turn previously static audit findings into executable regression gates before changing production code.

## New blind-spot suites

| Suite | Risk covered | Baseline result |
|---|---|---:|
| `p0-audit-incomplete-install-regression.test.ts` | Oversized, file-limit, depth-limit, and unreadable content passing the install gate | 4 failed |
| `p0-top-level-symlink-audit-seam.test.ts` | `scanHome` discovers a symlink that `auditHome` scans as zero files | 1 failed, 2 safety controls passed |
| `audit-blindspot-action-inputs.test.ts` | GitHub Action expression-to-Bash injection and unpinned `latest` execution | 3 failed |
| `audit-blindspot-output-safety.test.ts` | Secret leakage and terminal control characters in findings/MCP descriptions | 5 failed |
| `audit-blindspot-redirect-safety.test.ts` | Redirect downgrade/private-target SSRF and cross-origin credentials | 3 failed |
| `audit-backup-link-blindspots.test.ts` | Symlink and hardlink entries accepted during restore | 2 failed |
| `audit-diff-complexity-blindspots.test.ts` | Quadratic LCS memory exhaustion with semantic golden controls | 1 resource test failed, 3 golden controls passed |
| `audit-state-transaction-blindspots.test.ts` | Toggle/remove leaving torn state after an intermediate failure | 2 failed |

## Reproduction result

Command:

```text
pnpm exec vitest run <the eight suites above>
```

Result:

- Test files: 8 failed / 8.
- Tests: 21 failed, 5 passed.
- Duration: 1.52 seconds for the combined focused run.
- The 5 passing tests are controls for existing safe behavior: nested links remain unfollowed, invalid top-level links do not invent skills, and small diff output semantics remain stable.

## Confirmed impact

1. Skills with malicious content beyond audit limits were physically installed into the temporary Agent skills directory.
2. A top-level symlink skill was discovered but reported `scannedFiles=0` and was not blocked.
3. Action inputs remained executable shell source and the npm package default remained `latest`.
4. Literal settings secrets, CLI arguments, URL credentials, and ESC/OSC bytes reached report strings unchanged.
5. Redirecting clients did not enforce manual per-hop policy or a cross-origin credential boundary.
6. Restore accepted symlink and hardlink archive entries.
7. A 5,000-line near-identical diff aborted under a 192 MiB V8 heap; current LCS is O(m*n) time and O(m*n) memory.
8. A failed toggle changed `skills.json` before snapshot failure; a failed remove deleted the target before discovering a corrupt lock file.

## Acceptance criteria for the post-remediation run

- All 26 focused tests pass without weakening assertions.
- Existing full test count does not regress.
- Audit incompleteness is represented explicitly and blocks install unless force is recorded.
- Small diff golden behavior stays stable while the large resource test exits successfully.
- Failure paths preserve the complete pre-operation state or leave a recoverable transaction record.

## Evidence caveats

- The focused state tests cover two deterministic failure seams; SIGKILL and concurrent-writer recovery require new transaction hooks and process-level tests during implementation.
- The Action tests are local/static and fake-process tests; no privileged GitHub runner or real secrets were used.
- Redirect tests use injected fetch implementations and do not depend on external DNS.
