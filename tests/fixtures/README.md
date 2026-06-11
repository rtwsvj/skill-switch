# tests/fixtures — 假目录与样本总目录

铁律:真实 agent 配置目录(`~/.claude`、`~/.codex`、`~/.agents`、`~/.gemini`)永远只读。
一切涉及写入/遍历的测试都指向本目录下的假结构;`tests/setup.ts` 另将 HOME 重定向到临时目录兜底。

## home-basic/(S1.1)

模拟一个用户 home,覆盖 3 个 agent 的全局 skills 目录、6 个 skill 样本。
目录约定与 `src/vendor/vercel-skills/agents.ts` 一致:claude-code → `.claude/skills`,
universal agents → `.agents/skills`,gemini-cli → `.gemini/skills`。

| 路径 | 设计意图 |
|---|---|
| `.claude/skills/git-helper/` | 良性规范样本:frontmatter 完整,name=目录名 |
| `.claude/skills/commit-style/` | 良性规范样本:同一 agent 下多 skill 的枚举用例 |
| `.claude/skills/broken-frontmatter/` | **坏样本**:YAML 非法(未闭合 flow sequence),scan 必须记 error 字段而非抛出(S1.3 验收) |
| `.agents/skills/deploy-checklist/` | 良性 universal 样本:验证 `.agents/skills` 体系被盘点 |
| `.agents/skills/mismatched-name/` | **坏样本**:frontmatter `name: release-runbook` ≠ 目录名,供 scan 记录、S5 lint 报错 |
| `.gemini/skills/code-review-helper/` | 良性样本:第三个 agent,验证跨 agent 枚举 |

结构不变量由 `tests/fixtures.test.ts` 锁定;改动本目录必须同步改该测试。

## 规划中(随切片创建)

- `skills-malicious/`(S2.2–S2.4):audit 恶意样本,逐条对应规则 ID
- `skills-benign/`(S2.5):audit 良性对照,评分 ≥90
- 本地 git 仓 fixture(S3.3):file:// 协议离线安装源
