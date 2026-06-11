# Third-Party Notices

本项目以"拼好码"方式集成以下第三方材料。vendor 快照的逐文件清单与本地改动见各 `src/vendor/*/UPSTREAM.md`。

## 已 vendor 代码

| 来源 | License | 快照 commit | 说明 |
|---|---|---|---|
| [vercel-labs/skills](https://github.com/vercel-labs/skills) | MIT(声明于上游 package.json,上游无独立 LICENSE 文件) | `be0dd25b` | agent 映射表与类型 + git/source-parser/local-lock(`src/vendor/vercel-skills/`;git.ts 有两处 simple-git 适配改动,见 UPSTREAM.md) |
| [Karanjot786/agent-skills-cli](https://github.com/Karanjot786/agent-skills-cli) | MIT | `956140bf` | 冲突检测、上下文预算、lock 设计(`src/vendor/agent-skills-cli/`) |

## 规则/思路移植(非代码复制)

| 来源 | License | 用途 |
|---|---|---|
| [agentskill-sh/ags](https://github.com/agentskill-sh/ags) `skills/learn/references/SECURITY.md` | MIT | S2 audit 规则库的规格来源(检测类目与评分公式),逐条注明章节 |
| [agentskills/agentskills](https://github.com/agentskills/agentskills) `skills-ref`(Python) | Apache-2.0 | S5 lint 校验规则移植为 TS(name/description/compatibility/字段白名单),保留本声明作为 attribution |
| [xingkongliang/skills-manager](https://github.com/xingkongliang/skills-manager) | MIT | 备份/回滚与 preset+sync 思路参考(S3/S4),不复制代码 |
| [ryoppippi/ccusage](https://github.com/ryoppippi/ccusage) | MIT | transcript 路径发现与防御性解析模式参考(S8),不复制代码 |
