# Contributing to skill-switch

Thanks for your interest! Bug reports, ideas, and pull requests are all welcome.

## Getting started

```bash
pnpm install
pnpm test          # vitest
pnpm test:coverage # v8 coverage, including rules/
pnpm typecheck     # tsc --noEmit
pnpm lint          # biome
pnpm cli --help    # run the CLI from source (= skill-switch)
(cd macos && swift run)    # run the native SwiftUI app locally (macOS only)
(cd macos && swift test)   # Swift bridge/model tests
```

CLI requirements: Node ≥ 20, pnpm 10, Git, and a system `tar`. Native app
requirements: macOS 14+, Swift 6 / Xcode Command Line Tools, `sips`, and
`iconutil`. The retired Tauri/React app is not a development entry point.

Use an isolated home for manual exercises:

```bash
HOME="$(mktemp -d)" pnpm cli status
pnpm cli audit ./tests/fixtures/skill-safe --home "$(mktemp -d)"
```

## Ground rules

- **Never touch real config in tests.** All read and write paths run against a temporary `HOME` / `--home <dir>`. Do not point a test at real agent directories (`~/.claude`, `~/.codex`, `~/.gemini`, …).
- **Tests come with the change.** New behavior needs a test; bug fixes need a regression test. Keep the suite green (`pnpm test`), types clean (`pnpm typecheck`), and lint clean (`pnpm lint`).
- **Safety is the point.** Changes to audit completeness, install gating, operation locking, compensating rollback, path traversal, symlinks, archive extraction, redirects, or output redaction require adversarial regression tests. See [docs/known-limitations.md](docs/known-limitations.md).
- **Describe state guarantees precisely.** A per-home operation lock serializes cooperating writers, state files use atomic replacement, and selected commands use snapshots/compensation. This is not a cross-filesystem ACID transaction and a legacy agent snapshot does not include every `.skill-switch` state file.
- **Keep read-only claims honest.** CLI `stats` and `doctor` may update privacy-reduced derived caches. MCP tools must remain filesystem read-only; MCP stats runs with its cache disabled.
- **Treat packages as CLI-only.** The supported npm contract is the `skill-switch` bin, not a package-root Node library import.
- **Vendored code stays faithful.** Files under `src/vendor/` are upstream snapshots — don't reformat them; record any change in `src/vendor/.../UPSTREAM.md`.

## Pull requests

1. Fork and branch from `main`.
2. Keep PRs focused; describe the user-facing change and how you verified it.
3. CI (typecheck → lint → tests/coverage → Swift build/test) must pass for the affected surfaces.
4. For packaging changes, run `bash -n macos/build-app.sh`, build on the target CPU,
   and verify the embedded CLI and Info.plist versions. Never add placeholder
   hashes or advertise artifacts the workflow does not produce.

## Reporting security issues

If you find a vulnerability — especially anything that lets a malicious skill slip past the audit gate or escape its sandbox — please open an issue describing the vector and a minimal reproduction. Responsible disclosure is appreciated.

## License

By contributing, you agree your contributions are licensed under the project's [MIT License](./LICENSE).
