# UPSTREAM — vercel-labs/skills

- 上游仓库:https://github.com/vercel-labs/skills
- 快照 commit:`be0dd25b4a8665894a56f45ef582cc02ca802c39`(2026-06-11,v1.5.11)
- License:MIT——上游仓库根目录**无 LICENSE 文件**,MIT 声明于其 `package.json` 第 120 行(`"license": "MIT"`);上游另含 `ThirdPartyNoticeText.txt`。本仓库在 `THIRD_PARTY_NOTICES.md` 中登记。

## 已快照文件(来源路径 → 本目录)

| 上游路径 | 文件 | 用途 |
|---|---|---|
| `src/agents.ts` | `agents.ts`(749 行) | 71 个 agent 的目录映射表 + `detectInstalledAgents()` 等 |
| `src/types.ts` | `types.ts`(128 行) | `AgentType`/`AgentConfig`/`Skill` 等类型 |
| `src/constants.ts` | `constants.ts`(3 行) | `.agents/skills` 通用目录常量 |
| `src/git.ts` | `git.ts`(261 行) | shallow clone + ref + gh 回退,GitHub url 解析(S3.2,方案 A) |
| `src/source-parser.ts` | `source-parser.ts`(438 行) | github/owner-repo/subpath 多源解析(S3.2) |
| `src/local-lock.ts` | `local-lock.ts`(182 行) | 项目级锁:skillPath + sha256 内容哈希,设计为提交进版本库(S3.2) |

S3.2 采用**方案 A(最小 vendor)**:只取 git/source-parser/local-lock 三件,不整体 vendor
`installer.ts`(其 import 闭包另含 @clack/prompts 交互式 UI、plugin-manifest、add/sync 命令层
与 picocolors——与 CI 定位冲突)。install 编排由 skill-switch 自写(S3.3)。

## 本地改动

- `git.ts` 两处(仅为适配 simple-git v3.36.0 + NodeNext/tsc,语义不变,均在文件内就地注释):
  1. 默认导入 `import simpleGit from 'simple-git'` → 具名导入 `import { simpleGit } from 'simple-git'`(tsc 不认 CJS 默认导出可调用)。
  2. `simpleGit({ …, env })` 的 `env` 选项 → 链式 `.env({…})`(v3.36.0 的 SimpleGitOptions 不含 env,经实例方法设置)。
- 其余文件:逐字节快照。

## 有意未快照

- `src/detect-agent.ts`:依赖 `@vercel/detect-agent` 包与上游 `telemetry.ts`,功能是检测"CLI 当前运行在哪个 agent 内",非盘点所需;`detectInstalledAgents()` 已覆盖已装 agent 检测。
- `src/installer.ts`、`install.ts`、`git.ts`、`source-parser.ts`、`skills.ts`、`local-lock.ts`、`skill-lock.ts`:S3(写层基建 + install + lock)再行快照,届时更新本文件并评估 `providers/wellknown.ts`(804 行)与 `simple-git` 依赖。

## 维护

- 上游 `agents.ts` 漂移极快(Codex 路径半年内已迁移过一次),按 ROADMAP 例行任务 R1 每月 `diff` 一次上游。
- 更新方式:重新快照 + diff 审查,本地永不直接修改;若必须改动,逐条登记于"本地改动"。
