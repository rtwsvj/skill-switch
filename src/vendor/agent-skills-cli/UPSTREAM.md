# UPSTREAM — Karanjot786/agent-skills-cli

- 上游仓库:https://github.com/Karanjot786/agent-skills-cli
- 快照 commit:`956140bfce17aab9ef7ba9afbb12ee0bd8a8ef1c`(2026-05-17,v1.1.9)
- License:MIT(上游根目录 `LICENSE`,Copyright (c) 2026 Karanjot786);已登记于 `THIRD_PARTY_NOTICES.md`。

## 已快照文件(来源路径 → 本目录)

| 上游路径 | 文件 | 用途 |
|---|---|---|
| `src/core/conflict-detector.ts` | `conflict-detector.ts`(456 行) | 矛盾指令 + 主题重叠启发式检测(S5 触发健康度) |
| `src/core/context-budget.ts` | `context-budget.ts`(394 行) | token 估算 + 预算内组合选择(S5) |
| `src/core/skill-lock.ts` | `skill-lock.ts`(222 行) | LockEntry 设计参考:git 来源的 version 即 commit SHA(S3 合并入 skills.lock schema) |

三个文件零相对导入,外部依赖仅 `gray-matter` + node 内置模块。

## 本地改动

无(逐字节快照)。

## 注意

- **上游全仓库无任何测试**,快照代码视为未经测试:接线切片(S3/S5)必须先补行为测试再使用。
- 单人维护、生态绑 SkillsMP;vendor 即快照,不依赖其存续。
