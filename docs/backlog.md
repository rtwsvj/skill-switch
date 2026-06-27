# 产品待办 / Product Backlog

> 本文档基于对 11 个竞品(trivy、gitleaks、semgrep、checkov、grype/syft、1Password CLI、gh CLI、pre-commit、osv-scanner、snyk、dependabot)的深度 UX 与功能研究,提炼出的优先级路线图。项目发货时会从本文档拉动相应项进 CHANGELOG,保持长期可视。

**现状:**优先级 A/B/C 的部分项已在 v0.9(Unreleased)实现中;参见 [CHANGELOG](../CHANGELOG.md)。

---

## 优先级 A — 上手体验(最高 ROI)

上手快、反馈明确的核心功能。重点是让新用户看到即时价值,降低采用摩擦。

### 🎯 help 分组 + QUICK START 块

**价值:**20+ 命令现在平铺,新手看不清优先级。分组后能一眼找到最常用命令。

**启发来源:**gh CLI(子命令按逻辑分组,如 `gh repo`/`gh issue`),trivy(核心命令置前)。

**工作量:**S(约 1 人日)

---

### 🎯 `status` 一览命令

**价值:**用户想快速诊断「现在怎么样」——skills 总数、风险评分、漂移现状、上次更新时间。一条命令看清全局。

**启发来源:**gh `status` 显示 auth 状态与权限,1Password `op item list` 快速浏览清单,cargo-vet 的健康指标。

**工作量:**M(约 2 人日)

---

### 🎯 可操作的空状态

**价值:**audit/show/list 等命令返回空时,提示用户「下一步该做什么」(如「0 个 skills —— 试试 `skill-switch init` 发现已装的」)。

**启发来源:**gh 的友好错误提示与 next-step 引导。

**工作量:**S(约 1 人日)

---

### 🎯 操作结尾计数小结

**价值:**sync/install 后输出「启用 N 个、停用 M 个、已快照 K 次」之类的摘要,让用户明确感受到实际改动。

**启发来源:**trivy 输出末尾的「Critical: 5, High: 12」聚合,npm 的「added X packages, removed Y packages」。

**工作量:**S(约 1 人日)

---

## 优先级 B — 输出 & CI 接入(补企业缺口)

让 skill-switch 能融入已有的团队工作流与 CI 基础设施。

### 🎯 JUnit XML 输出

**价值:**CI 生态需要多种格式:SARIF 上传 code-scanning,GitHub Annotations 用 `--format github`,但 Jenkins/GitLab/CircleCI 等仍需 JUnit XML。

**启发来源:**semgrep 与 trivy 都支持 `--format junit`;是接入遗留 CI 的必要条件。

**工作量:**M(约 2 人日,需扩展 `--format` 枚举)

---

### 🎯 `--exit-code <n>` 覆盖

**价值:**「只报告,不失败」场景(如 pull-request 反馈):findings 照常输出,但总是 exit 0。也支持 `--exit-code 1` 表「仅高严重度失败」。

**启发来源:**gitleaks `--exit-code 0` 与 trivy `--exit-code` 参数。

**工作量:**S(约 1 人日)

---

### 🎯 严重度过滤 `--min-severity`

**价值:**只关心 high/critical 的团队不想被 low-severity 刷屏。`audit --min-severity high` 直接在审计阶段过滤。

**启发来源:**trivy `--severity CRITICAL,HIGH`,grype 的 severity 范围过滤。

**工作量:**S(约 1 人日)

---

### 🎯 行内注释抑制

**价值:**技能或配置文件本身含有抑制注解,就能局部关闭审计(如 `# skill-switch:suppress mcp/server-added` 单行)。自动生成修复建议时也插入该注解。

**启发来源:**semgrep `# nosemgrep: <rule>`,gitleaks 的 allowlist 与行级抑制。

**工作量:**M(约 2 人日,需解析注解并在修复时生成)

---

### 🎯 pre-commit 钩子脚手架

**价值:**开发者用 `skill-switch pre-commit-install` 自动生成 `.pre-commit-hooks.yaml` 条目,git push 前自动审计(无需额外依赖)。

**启发来源:**gitleaks 与 pre-commit 生态深度集成,降低采用摩擦。

**工作量:**S(约 1 人日)

---

## 优先级 C — 套餐(pack)深化

packs 是 skill-switch 的差异化功能——能让用户在多台机、多个 agent 间可靠地复用精选技能组合。

### 🎯 发现包富集来源 + `packs install`

**价值:**`packs suggest` 现在只读对话。未来可选地连接「精选包仓库」(线上 registry)发现预制包,然后 `packs install <registry-pack-id>` 一键拉下并应用。支持跨机同步(从 cloud sync 拉),多 agent 重装。

**启发来源:**Brewfile / `mise` 的跨机包环境复用,devcontainer features registry。

**工作量:**M(约 2-3 人日,需 registry 架构与同步 UX)

---

### 🎯 `extends` 继承 + 内置精选包

**价值:**pack.json 支持 `extends: ["builtin/recommended", "../shared-pack.json"]`,便于不同项目复用共同基础。同时船载几个推荐包(如「安全最小集」「生产力标配」)。

**启发来源:**eslint-config 的 `extends`,Brewfile 的 bundle 逻辑,GitHub Actions 的 composite action。

**工作量:**M(约 2 人日)

---

### 🎯 required/optional skill 标注 + lockfile

**价值:**pack 作者可标记某些 skill 为 required(install 时必须存在或报错),某些为 optional(有就用,没有也不报错)。同时生成 `pack.lock` 记录已验证过的 skill 版本信息,保障可重现性。

**启发来源:**package.json 的 `dependencies` vs `optionalDependencies`,npm/yarn lockfile,容器镜像摘要。

**工作量:**M(约 2 人日)

---

## 优先级 D — 漂移审批体验

配置漂移检测已有,但单向检测 + 静态基线还不够——需要交互式审批与变更叙述,让团队能放心接受漂移。

### 🎯 cargo-vet 式交互审批

**价值:**发现漂移时进入交互式 REPL,逐条展示变更(MCP server 命令换了、新增了权限等),用户逐个 approve/deny,结果记入 audit 日志与 lock 文件。减少「看不清改了什么」的心理障碍。

**启发来源:**cargo-vet / cargo-crev 的逐条审批流,让供应链决策可追溯。

**工作量:**L(约 4-5 人日,需交互 UX + 审批历史机制)

---

### 🎯 "改了啥"叙述化 diff

**价值:**漂移基线变了时不只输出 hash 变化,而是用人话描述「MCP server X 的 command 从 `/path/a` 改成 `/path/b`」「settings 新增了 auto-approve key Z」。便于快速理解影响范围。

**启发来源:**dependabot 的「dependency updates」变更摘要,cargo-update 的改动说明。

**工作量:**M(约 2 人日)

---

## 优先级 E — GUI

GUI 是 macOS 用户的主要入口,但当前功能还基础。这些项都是中等 ROI 的质量提升。

### 🎯 主从布局 + 状态徽章 + 批量操作 + 撤销 toast

**价值:**
- **主从布局:**左侧 skills 列表,右侧详情面板,便于同时查看列表与某个 skill 的安全评分。
- **状态徽章:**各 skill 旁显示「已停用」「风险」等视觉标记。
- **批量操作:**选中多个 skills,一次性启用/停用/删除,减少逐个操作的烦恼。
- **撤销 toast:**操作后弹出 toast 并支持 5 秒内点「撤销」回滚(需快照支持)。

**启发来源:**1Password 主从界面与 undo,Tower/Sublime Text 的批量操作与 undo toast,macOS Finder 的快速操作。

**工作量:**L(约 4-5 人日,需重构 React 布局 + undo 状态机)

---

## 🚩 大战略赌注(需单独立项)

这些不适合纳入常规优先级,但长期影响重大,建议单独评估与立项。

### 把 skill-switch 做成 MCP server

**启发:**semgrep 有 MCP server,让 Cursor/Claude Desktop/任何支持 MCP 的编辑器实时调用。

**机会:**让 skill-switch 的审计和管理能力直接融入开发流程,无需离开编辑器。

**阶段:**L(需专项)

**看好度:**最看好。这是 skill-switch 从「工具」升为「基础设施」的转折点。

---

### 跨 IDE 市场分发 & 公开套餐 registry

**两个紧密相关的战略:**
1. **跨 IDE 分发:**当前仅 macOS。支持 Linux .deb/.AppImage 与 Windows installer,在对应包管理器(apt/snap/chocolatey)上架。
2. **公开套餐 registry:**让社区可发布、搜索、共享精选包(如「Python 审计包」「前端开发标配」),类似 npm registry 或 GitHub Marketplace。

**看好度:**L。这是打开社区生态的关键。

---

## 如何反馈与贡献

发现问题或有功能建议,请在 [GitHub Issues](https://github.com/rtwsvj/skill-switch/issues) 提 issue,说明使用场景与期望行为。欢迎 pull request!
