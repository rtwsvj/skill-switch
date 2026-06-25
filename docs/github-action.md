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
| `format` | `sarif` | `human` / `json` / `sarif` |
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

## 配项目级策略

把 `.skill-switch-policy.json` 放进仓库根即可调整阻断严重度下限与规则抑制
(`failOn` / `suppress`),Action 会自动采用。详见 README 与 CHANGELOG。
