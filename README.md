# skill-switch

跨 agent 的 skill 治理层 CLI:盘点、安全体检、声明同步、锁校验、漂移诊断和使用统计;它不是各家 skill 安装/删除 CRUD 工具的 fork。

## Run

开发仓库内运行:

```bash
pnpm install
pnpm cli --help
pnpm cli scan --home tests/fixtures/home-basic
```

F11 的 bin shim 落地后,也可以通过 `skill-switch` 直接运行同一套命令:

```bash
skill-switch --help
skill-switch doctor --home /path/to/fake-home --ci
```

## Safety Model

只读命令不会写 agent 配置目录:`scan`、`audit`、`lint`、`doctor`、`drift`、`stats`、`lock` 默认查看模式。

写命令只通过显式解析的 `--home` 目标工作:`install`、`toggle`、`sync`、`remove`。写入真实 `~/.claude`、`~/.codex`、`~/.agents`、`~/.gemini`、`~/.hermes` 等目录前必须格外确认;测试和演练应使用 fixture 或临时 home。写命令会在修改前对受影响 agent 目录拍快照,快照默认在 `<home>/.skill-switch/backups/`。

目录解析统一走 `src/core/paths.ts`;测试基建会重定向 HOME,防止误写真实配置目录。

## Commands

| Command | Purpose | Example |
|---|---|---|
| `scan` | 盘点各 agent 已安装 skills,坏 frontmatter 以 error 字段呈现。 | `pnpm cli scan --home tests/fixtures/home-basic --json` |
| `audit` | 对 skill 目录做安全体检;任意 critical/high 或 score<70 会阻断。 | `pnpm cli audit tests/fixtures/skills-benign/api-client` |
| `install` | 安装本地或 git source,装前 audit、快照,写 lock 与声明。 | `pnpm cli install ./tests/fixtures/some-source --agent claude-code --home /tmp/ss-home` |
| `toggle` | 按 `skills.json` 开关单个 skill;codex 使用 config.toml 原生开关。 | `pnpm cli toggle tidy-notes --off --home /tmp/ss-home` |
| `sync` | 应用整份 `skills.json` 到磁盘;支持 dry-run。 | `pnpm cli sync --home /tmp/ss-home --dry-run` |
| `remove` | 一致性拆除某 agent 的 skill:磁盘、lock、声明一起清理。 | `pnpm cli remove tidy-notes --agent claude-code --home /tmp/ss-home` |
| `lint` | 校验 skill 规范、跨家移植风险、冲突和上下文预算。 | `pnpm cli lint tests/fixtures/home-basic --target codex` |
| `doctor` | 对账声明、锁和磁盘,发现 missing/content-drift/stale-lock/extra-locked。 | `pnpm cli doctor --home /tmp/ss-home --ci` |
| `drift` | 比较上游 HEAD、锁定 commit 和本地内容 hash 的漂移状态。 | `pnpm cli drift --home /tmp/ss-home --json` |
| `stats` | 解析 Claude transcript,统计 skill 触发次数和僵尸 skill。 | `pnpm cli stats --home /tmp/ss-home --days 30` |
| `lock` | 查看 `skills.lock`;`--verify` 重算磁盘 hash。 | `pnpm cli lock --home /tmp/ss-home --verify` |

## Exit Codes

- Most read/report commands exit 0 when they can produce a report.
- `audit` exits 1 when a skill should be blocked: any critical/high finding or score below 70.
- `doctor --ci` exits 1 when declaration, lock, and disk are not aligned.
- `lock --verify` exits 1 when a locked target is missing, unknown, or hash-mismatched.
- Top-level action errors print `错误: <message>` to stderr and exit 1 without a stack trace.

## Project Docs

- [AGENTS.md](./AGENTS.md): collaboration rules, safety boundaries, vendor discipline, and iteration workflow.
- [docs/ROADMAP.md](./docs/ROADMAP.md): shipped slices and candidate backlog.
- [docs/changes/](./docs/changes): per-task operation records and verification evidence.
