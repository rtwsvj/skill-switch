# UPSTREAM — Karanjot786/agent-skills-cli

- 上游仓库:https://github.com/Karanjot786/agent-skills-cli
- 快照 commit:`956140bfce17aab9ef7ba9afbb12ee0bd8a8ef1c`(2026-05-17,v1.1.9)
- License:MIT(上游根目录 `LICENSE`,Copyright (c) 2026 Karanjot786);已登记于 `THIRD_PARTY_NOTICES.md`。

## 已快照文件(来源路径 → 本目录)

| 上游路径 | 文件 | 用途 |
|---|---|---|
| `src/core/conflict-detector.ts` | `conflict-detector.ts`(456 行) | 矛盾指令 + 主题重叠启发式检测(S5 触发健康度) |
| `src/core/context-budget.ts` | `context-budget.ts`(394 行) | token 估算 + 预算内组合选择(S5) |

上游文件原为零相对导入。本地安全补丁将两个 `gray-matter` 调用改为
`src/core/frontmatter.ts` 的受限 YAML 1.2 解析器；刷新上游快照时必须保留此补丁。

## 本地改动

- 2026-08:删除 `skill-lock.ts` 快照。其唯一用途是 S3 lock schema 的"commit 即
  version"设计参考,该 schema 已落地于 `src/core/lock.ts`;快照零生产消费者,
  原文件可从本仓库 git 历史(commit `2dbf07b`)或上游找回。

## 注意

- **上游全仓库无任何测试**,快照代码视为未经测试:接线切片(S3/S5)必须先补行为测试再使用。
- 单人维护、生态绑 SkillsMP;vendor 即快照,不依赖其存续。
