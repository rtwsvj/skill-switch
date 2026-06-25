# 在 CI 里跑 skill-switch(GitHub Action)

`skill-switch` 提供一个可复用的 GitHub Action,让任何仓库在 CI 里自动审计自己的
AI agent skills 与 MCP/agent 配置,并把结果上传到 GitHub code-scanning。

> 前提:`@rtwsvj/skill-switch` 已发布到公共 npm(Action 内部用 `npx @rtwsvj/skill-switch`;命令名仍是 `skill-switch`)。

## 最小用法

在消费仓库新建 `.github/workflows/skill-switch.yml`:

```yaml
name: skill-switch audit
on: [push, pull_request]

permissions:
  contents: read
  security-events: write   # 上传 SARIF 到 code-scanning 必需

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: rtwsvj/skill-switch@v0.6.1
        with:
          path: .
          args: --configs        # 同时审计 ~/.claude 等 agent 配置(可去掉)
```

命中阻断级问题(反弹 shell、外传、钓鱼凭据、危险 MCP 等)时该步骤会失败(exit 1),
SARIF 也会出现在仓库的 **Security → Code scanning** 里。

## 输入参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `path` | `.` | 要审计的路径 |
| `args` | `--configs` | 传给 `skill-switch audit` 的额外参数 |
| `version` | `latest` | 使用的 npm 版本;生产建议 pin(如 `0.6.0`) |
| `node-version` | `20` | 运行所用 Node 版本 |
| `format` | `sarif` | `human` / `json` / `sarif` / `github` |
| `output` | `skill-switch.sarif` | 输出文件(sarif 时用于上传) |
| `upload-sarif` | `true` | 是否上传到 code-scanning(仅 sarif) |
| `fail-on-findings` | `true` | 命中阻断级问题时是否让步骤失败 |

输出:`exit-code`(skill-switch audit 的退出码)。

## 只看不拦(软门禁)

想先观察、不让 CI 失败:

```yaml
      - uses: rtwsvj/skill-switch@v0.6.1
        with:
          fail-on-findings: 'false'
```

## PR 内联注解(`--format github`)

`format: github` 会让 skill-switch 直接把每条 finding 输出为 GitHub Actions
[工作流注解命令](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions)。
GitHub Actions 运行器自动把这些注解内联显示在 PR diff 对应行上,无需 `security-events: write` 权限,无需 code-scanning 设置:

```yaml
name: skill-switch audit (inline annotations)
on: [pull_request]

permissions:
  contents: read   # 无需 security-events: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: rtwsvj/skill-switch@main   # github 格式:v0.7.0 发布后可 pin 该 tag
        with:
          format: github
          args: --configs
```

注解级别映射:
- `critical` / `high` → `::error`(显示为 PR 检查失败项)
- `medium` / `low` → `::warning`(建议级,不阻断)
- 已被策略抑制或已基线化 → `::notice`(不阻断,仅告知)

末尾自动追加一行汇总 `::notice::skill-switch: N blocking, M advisory, K baselined`。

> 提示:同时需要 code-scanning 归档时可继续用 `format: sarif`(默认)。两种格式可在不同步骤里并用。

## 配项目级策略

把 `.skill-switch-policy.json` 放进仓库根即可调整阻断严重度下限与规则抑制
(`failOn` / `suppress`),Action 会自动采用。详见 README 与 CHANGELOG。
