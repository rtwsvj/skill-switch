# Contributing to skill-switch

Thanks for your interest! Bug reports, ideas, and pull requests are all welcome.

## Getting started

```bash
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit
pnpm lint          # biome
pnpm cli --help    # run the CLI from source (= skill-switch)
pnpm --dir gui tauri dev   # run the desktop app locally
```

Requirements: Node ≥ 20 and pnpm 10.

## Ground rules

- **Never touch real config in tests.** All write paths run against `tests/fixtures/` or a throwaway `--home <dir>`. Real agent directories (`~/.claude`, `~/.codex`, `~/.gemini`, …) are read-only in tooling.
- **Tests come with the change.** New behavior needs a test; bug fixes need a regression test. Keep the suite green (`pnpm test`), types clean (`pnpm typecheck`), and lint clean (`pnpm lint`).
- **Safety is the point.** This is a security/governance tool — changes that weaken the pre-install audit, the snapshot-before-write guarantee, or the path-traversal / symlink hardening need a strong rationale and explicit tests. See [docs/known-limitations.md](docs/known-limitations.md) for documented blind spots.
- **Vendored code stays faithful.** Files under `src/vendor/` are upstream snapshots — don't reformat them; record any change in `src/vendor/.../UPSTREAM.md`.

## Pull requests

1. Fork and branch from `main`.
2. Keep PRs focused; describe the user-facing change and how you verified it.
3. CI (typecheck → lint → test → GUI build) must pass.

## Reporting security issues

If you find a vulnerability — especially anything that lets a malicious skill slip past the audit gate or escape its sandbox — please open an issue describing the vector and a minimal reproduction. Responsible disclosure is appreciated.

## License

By contributing, you agree your contributions are licensed under the project's [MIT License](./LICENSE).
