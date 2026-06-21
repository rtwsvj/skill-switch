# Roadmap

> 本页是公开路线图,诚实反映项目现状与方向;内容随版本迭代更新。

**愿景 / Vision:** 成为跨 AI 编程工具的最小可信 skill 治理层——让任何人都能放心安装、开关、审计、回滚来自不同来源的 skill,而不必信任每个 skill 的作者。

---

## 近期 / Near-term — 稳定与加固

目标是在扩展功能之前把现有能力做扎实。以下每项都有明确的完成标准。

### 安全审计补盲 (Audit recall improvements)

当前 `audit` 是静态规则扫描器;[docs/known-limitations.md](known-limitations.md) 记录了四个已知漏判:

| 漏判 | 计划 |
|---|---|
| Base64 编码载荷 (`base64-encoded-payload`) | 对 `base64 -d` / `atob()` 等解码调用的输出做二次扫描,无需执行 |
| Unicode 同形字符 (`unicode-homoglyph-command-and-endpoint`) | 扫描前对关键词做 Unicode 同形归一化 (NFKC + 常见拉丁替换表) |
| JavaScript 字符串拼接 endpoint (`javascript-string-concat-endpoint`) | 对相邻字符串字面量做简单常量折叠,再跑外传规则 |
| 跨行数据流拆分 (`cross-line-token-and-endpoint-split`) | 在单文件内做轻量级跨行变量追踪(仅标量赋值+引用,不跑完整 AST) |

修复后须同步更新 `tests/audit-recall-corpus.test.ts` 中对应的 `miss` 样本为 `hit`。

### 测试覆盖率度量 (Test coverage baseline)

当前没有覆盖率报告。目标:在 CI 中开启 `vitest --coverage`,建立基线,标注哪些核心路径(backup/restore、audit、doctor 三方对账)覆盖率 < 80% 并补测。

### 跨平台 CLI CI (Linux + Windows CI)

当前 CI 只在 macOS (Apple Silicon) 上跑。目标:在 GitHub Actions 增加 `ubuntu-latest` 和 `windows-latest` job,跑 CLI 单元测试 + 集成测试,消除隐性平台依赖。

### 退出码契约测试 (Exit-code contract tests)

README 文档了 `audit`、`doctor --ci`、`lock --verify` 的 exit-code 语义;当前没有专门测这些约定的测试。目标:补充端到端测试,断言命令在已知输入下输出正确 exit code,防止静默回归。

### 大文件安全拆分 (Large-file refactors)

部分核心文件单文件超 400 行(如 `src/cli/commands/install.ts`、`rules/index.ts`)。目标:按职责拆分,不改行为,提高可读性与可测性。每次拆分附对应回归测试。

---

## 中期 / Medium-term — 功能

以下是在稳定基础上拟新增的能力,优先级从高到低。

### 更多 agent 支持

目前已支持 claude-code / codex / gemini-cli / cursor / copilot;计划:
- 完善 cursor、copilot 的 skill 目录读写路径(当前属实验支持)。
- 调研 Windsurf、Zed AI 等新兴工具,视其 skill 格式决定是否纳入。

### `init` / 模板命令 (Init command)

新用户第一步:运行 `skill-switch init` 扫描本机已有 skill,生成初始 `skills.json` 声明草稿,并提示是否纳入管理。降低「从零开始」的摩擦。

### `skills.json` JSON Schema + 校验

为 `skills.json` 和 `skills.lock.json` 发布正式 JSON Schema(发到 `docs/schema/`),`lint` 和 `install` 使用同一 schema 做运行时校验;编辑器可直接接入补全。

### 配置文件导入/导出 (Profile import/export)

支持 `skill-switch export --profile <name>` 把当前 `skills.json` + lock 打包成一个可分享的 `.ssp` 文件;`skill-switch import <file.ssp>` 恢复到另一台机器。便于团队/个人跨机同步。

### 更丰富的 diff/drift 展示 (Richer diff UX)

CLI `diff` 和 `drift` 目前输出纯文本;计划:
- `--format unified` 输出标准 unified diff(方便 pipe 到 `patch` 或 PR review)。
- GUI 的 diff 视图加行级高亮,区分新增/删除/修改。

### Watch 模式 (Watch mode)

`skill-switch watch`:监听各工具 skill 目录的文件变化,实时检测未经 `skill-switch install` 的写入并告警——防止绕过治理层的「偷偷安装」。

---

## 远期 / Long-term — 已知较难

以下项目技术难度高、依赖外部条件,或还没找到足够简单的实现路径,暂列为探索方向。

| 方向 | 难点 |
|---|---|
| **语义审计沙箱** (Semantic audit sandbox) | 在隔离环境中执行 skill 并观察副作用,需解决沙箱逃逸、跨平台执行环境、误报率等问题。 |
| **Linux / Windows 桌面包** (Linux + Windows app packaging) | GUI 使用 Tauri;Linux 需要额外的 `.deb`/`.AppImage` 打包与签名链路;Windows 需要 EV Code Signing 证书。 |
| **npm 发布 CLI** (npm publish) | 当前 `package.json` 中 `"private": true`,且 CLI 依赖 Node SEA sidecar 打包方式;计划在独立 npm 包可独立安装前先解决依赖隔离问题。 |

---

## 如何反馈 / How to contribute

发现问题或有功能建议:请在 [GitHub Issues](https://github.com/rtwsvj/skill-switch/issues) 提 issue,说明使用场景和期望行为。
