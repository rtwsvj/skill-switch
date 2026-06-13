# skill-switch

跨 agent 的 skill 治理层:在 Claude Code、Codex、Gemini CLI 等生态之间盘点、审计、锁定、同步、漂移诊断和使用统计,但不试图 fork 各家的 skill CRUD 工具。

`skill-switch` 适合在公开安装前、团队同步前、或 CI 闸门里回答三个问题:现在装了什么,安全吗,和声明/锁/上游还一致吗。

Status: v0.1.0 early release. The CLI is useful for local governance workflows, but public distribution is still intentionally conservative: clone + run is the canonical path, npm publishing is disabled with `private: true`, and macOS GUI artifacts are unsigned until the release owner completes Developer ID signing/notarization.

## Screenshots

![GUI overview](gui/docs/g1-overview.png)

![Audit dashboard](gui/docs/g1-audit.png)

![Skills inventory](gui/docs/g1-skills.png)

![Usage statistics](gui/docs/g1-usage.png)

![zh-CN locale](gui/docs/p1-i18n-zh-CN.png)

## Install And Run

Clone + run from the repo is always supported:

```bash
pnpm install
pnpm cli --help
pnpm cli scan --home tests/fixtures/home-basic --json
```

The repo-local bin shim can run the same CLI after dependencies are installed:

```bash
skill-switch --help
skill-switch doctor --home /path/to/fake-home --ci
```

Build all local release artifacts without publishing:

```bash
pnpm release
```

That command runs tests, typecheck, `npm pack --dry-run --json`, and the Tauri release build. It produces:

- `gui/src-tauri/target/release/bundle/macos/skill-switch.app`
- `gui/src-tauri/target/release/bundle/macos/skill-switch.app/Contents/MacOS/skill-switch-cli`
- `gui/src-tauri/target/release/bundle/dmg/skill-switch_0.1.0_aarch64.dmg`

The packaged GUI uses a Node SEA sidecar for CLI calls, so the packaged read-only dashboard sidecar does not need a `node` command on `PATH`. The `.app`/`.dmg` are still unsigned local artifacts; Gatekeeper-friendly distribution requires the manual signing and notarization steps in [docs/launch-checklist.md](docs/launch-checklist.md).

## Commands

| Command | Purpose | Example |
|---|---|---|
| `scan` | 盘点各 agent 已安装 skills;坏 frontmatter 以 `error` 字段呈现。 | `pnpm cli scan --home tests/fixtures/home-basic --json` |
| `audit` | 对单个 skill 目录或整个 home 做安全体检;任意 critical/high 或 score<70 会阻断。 | `pnpm cli audit --home /tmp/ss-home --json` |
| `install` | 安装本地或 git source;装前 audit、装前快照,并写 lock 与声明。 | `pnpm cli install ./my-skills --agent claude-code --home /tmp/ss-home` |
| `toggle` | 按 `skills.json` 开关单个 skill;Codex 使用 `config.toml` 原生开关。 | `pnpm cli toggle tidy-notes --off --home /tmp/ss-home` |
| `lint` | 校验 skill 规范、跨家移植风险、触发词健康度、冲突和上下文预算。 | `pnpm cli lint tests/fixtures/home-basic --target codex` |
| `doctor` | 对账 `skills.json`、`skills.lock` 和磁盘,发现 missing/content-drift/stale-lock/extra-locked。 | `pnpm cli doctor --home /tmp/ss-home --ci` |
| `drift` | 比较上游 HEAD、锁定 commit 和本地内容 hash,输出 in-sync/upstream-ahead/local-modified/diverged。 | `pnpm cli drift --home /tmp/ss-home --json` |
| `stats` | 解析 Claude transcript,统计 skill 触发次数和僵尸 skill。 | `pnpm cli stats --home /tmp/ss-home --days 30` |
| `lock` | 查看 `skills.lock`;`--verify` 重算磁盘 hash。 | `pnpm cli lock --home /tmp/ss-home --verify` |
| `sync` | 应用整份 `skills.json` 到磁盘;支持 `--dry-run` 和 JSON 输出。 | `pnpm cli sync --home /tmp/ss-home --dry-run` |
| `remove` | 一致性拆除某 agent 的 skill:磁盘、lock、声明一起清理。 | `pnpm cli remove tidy-notes --agent claude-code --home /tmp/ss-home` |
| `restore` | 列出快照,或按 `--id`/`--latest` 还原到 manifest 记录的来源目录。 | `pnpm cli restore --home /tmp/ss-home --latest` |

## Exit Codes

- Report-only commands exit 0 when they can produce a report.
- `audit` exits 1 when a skill should be blocked: any critical/high finding or score below 70.
- `doctor --ci` exits 1 when declaration, lock, and disk are not aligned.
- `lock --verify` exits 1 when a locked target is missing, unknown, or hash-mismatched.
- CLI action errors print `错误: <message>` to stderr and exit 1 without a stack trace.

## Safety Model

只读命令不会写 agent 配置目录:`scan`、`audit`、`lint`、`doctor`、`drift`、`stats`、`lock` 默认查看模式。

写命令只通过显式解析的 `--home` 目标工作:`install`、`toggle`、`sync`、`remove`、`restore --id/--latest`。写入真实 `~/.claude`、`~/.codex`、`~/.agents`、`~/.gemini`、`~/.hermes` 等目录前必须格外确认;测试和演练应使用 fixture 或临时 home。

写命令会在修改前做装前快照或操作前快照,默认存放在 `<home>/.skill-switch/backups/`。`restore` 还原前也会创建 pre-restore 快照。目录解析统一走 `src/core/paths.ts`;测试基建会重定向 HOME,防止误写真实配置目录。

安全加固边界:

- install/sync/remove 会拒绝路径穿越、绝对路径、NUL、隐藏名等 unsafe skill name。
- copy 模式跳过 symlink,避免把指向外部目录的链接带进 agent skill 目录。
- audit 不跟随 symlink,并有文件大小、文件数量、递归深度和单行匹配窗口上限。
- 当前 audit recall 边界见 [docs/known-limitations.md](docs/known-limitations.md)。

## GUI

GUI 是本仓内的本地 dashboard,用于查看 inventory、audit、doctor、stats、lock verify 等只读治理数据。Tauri Node SEA sidecar 使用只读白名单,当前允许:

- `scan --json`
- `audit --home --json`
- `doctor --json`
- `stats --days <N> --json`
- `lock --verify --json`

运行方式:

```bash
pnpm --dir gui dev
pnpm --dir gui tauri dev
pnpm --dir gui tui
```

构建 Tauri sidecar:

```bash
pnpm --dir gui bundle:cli
pnpm --dir gui build
pnpm --dir gui tauri build
```

GUI 已有 zh-CN、en、ja、es 四种语言,截图在 `gui/docs/*.png`。

## Data Files

- `<home>/.skill-switch/skills.json`:声明希望哪些 skill 出现在哪些 agent。
- `<home>/.skill-switch/skills.lock.json`:安装来源、commit、内容 hash 和 mode。
- `<home>/.skill-switch/backups/`:写命令的 tar.gz 快照与 sidecar manifest。

## Project Docs

- [AGENTS.md](./AGENTS.md): collaboration rules, safety boundaries, vendor discipline, and iteration workflow.
- [docs/ROADMAP.md](./docs/ROADMAP.md): shipped slices and candidate backlog.
- [docs/changes/](./docs/changes): per-task operation records and verification evidence.
- [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md): vendor snapshots and ported-rule attribution.
