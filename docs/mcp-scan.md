# `skill-switch mcp-scan` — 运行时 MCP 审计与 rug-pull 检测

roadmap 阶段 3 旗舰能力:闭合"工具清单只有连上才能看到"的最后一块缺口。
连配置里的 MCP server(经显式 opt-in),取实时工具清单,用既有静态规则审计工具描述(tool-poisoning),并把工具定义哈希成基线,再扫时报差异。

## 它做什么

- **运行时取清单**:对每个获准的 MCP server,跑 `initialize → notifications/initialized → tools/list → 断开`,把每个工具的 `{name, description, inputSchema}` 拿回来。
- **静态审计**:对工具描述/参数 schema 复用既有 `rules/`(80+ 条规则)做扫描——prompt-injection、外渗、不可见字符、不可信 host 等全部覆盖,无需新规则。
- **rug-pull 基线**:首次扫描把工具定义哈希入 `<home>/.skill-switch/mcp-scan-baseline.json`;再扫时哈希变化 → `mcp/tool-definition-changed` (high),新增 → `mcp/tool-added` (medium)。

## 威胁模型:为什么连接是有风险的

连接到一个 MCP server 本身就是新攻击面。本工具严格遵守规格铁律,把它压到最小:

| # | 铁律 | 实现位置 |
|---|---|---|
| 1 | **绝不自动连接**:无 flag 只列 server,不建立任何连接 | `src/cli/commands/mcp-scan.ts` 的 opt-in 门 |
| 2 | **逐 server 显式同意**:`--server <key>` 单点;`--all` 需 `--yes`;TTY 下逐个 y/N | 同上 |
| 3 | **stdio = 执行配置里的命令**:确认提示明说"这会启动一个本地进程" | `describeStdioCommand()` |
| 4 | **绝不调用 `tools/call`**:协议交互固定 4 帧 | `src/core/mcp-scan/client.ts` 写入的固定序列;测试断言 mock 日志全程无 `tools/call` |
| 5 | **超时硬杀**:默认 10s;stdio SIGTERM→SIGKILL;http AbortController | `client.ts` 的 `killChild` + `connectHttp` |
| 6 | **http 仅限 localhost 或 https**;headers/env VALUE 绝不入输出/日志/基线 | `assertScanUrl()` + client 错误信息只含 url.pathname |
| 7 | **默认 report-only**;`--ci` 才按 critical/high 阻断 | `shouldBlockForCi()` |

**stdio 子进程环境不继承父环境**:只透传配置里显式声明的 `env` 字段,外加一个安全的 `PATH`。这避免 `NODE_OPTIONS / SSH_AUTH_SOCK / AWS_*` 等被偷偷传给被审计的 server。

**响应体大小上限 2MB**:超限立即断开(不把超大响应读进内存,DoS 防御)。

## 与 `audit --configs` 的关系:互补不重叠

| 维度 | `audit --configs` | `mcp-scan` |
|---|---|---|
| 何时跑 | 静态(配置即代码) | 运行时(连 server) |
| 看什么 | `command`/`args`/`url`/`headers`/`autoApprove` 等配置身份 | `tools/list` 返回的工具定义 |
| 检测什么 | 危险配置、悬空 shell、外发到不可信 host、auto-approve 等 | tool-poisoning、prompt-injection in 描述、rug-pull |
| 风险 | 零网络、零 spawn | **会启动子进程或连远端** |
| 基线文件 | `<home>/.skill-switch/config-baseline.json`(或 `--write-config-baseline` 指定) | `<home>/.skill-switch/mcp-scan-baseline.json` |

**两者独立运行,各自管各自的基线文件,不互相覆盖**。建议 CI 同时跑:`audit --configs --config-baseline …` + `mcp-scan --all --yes --ci`。

## 用法

```bash
# 1. 看本机发现了哪些 MCP server(不连接)
skill-switch mcp-scan

# 2. 单个扫描(显式同意,无需 TTY)
skill-switch mcp-scan --server '.claude/mcp.json::filesystem' --yes

# 3. 全部扫描(非交互)
skill-switch mcp-scan --all --yes

# 4. CI 门控(存在 critical/high finding 即 exit 1)
skill-switch mcp-scan --all --yes --ci

# 5. 调整超时(默认 10s)
skill-switch mcp-scan --server '…' --yes --timeout 30000

# 6. 接受当前结果覆盖基线(用于工具定义本来就在变的情况)
skill-switch mcp-scan --server '…' --yes --reset-baseline

# 7. JSON 输出(机器消费)
skill-switch mcp-scan --all --yes --json

# 8. 用假 home 演练(与所有命令一致)
skill-switch mcp-scan --home /tmp/sandbox-home
```

### `--server <key>` 的 key 格式

`<source>::<name>`,其中 `<source>` 是配置文件 home-相对路径(`.claude/mcp.json` 等),`<name>` 是该文件中 `mcpServers.<name>` 的键名。

先 `skill-switch mcp-scan` 不带 flag 看一眼,每行末尾括号里就是 `<source>`,前面是 `<name>`,拼接即得。

## 输出样例(human 模式)

```
mcp-scan 报告
  home:      /Users/x
  baseline:  /Users/x/.skill-switch/mcp-scan-baseline.json  (本次扫描已建立基线)

[.claude/mcp.json::filesystem] protocol=2025-06-18 tools=3
  findings: 无

汇总
  servers:        1
  connected:      1
  findings:       0
    critical:     0
    high:         0
    medium:       0
    low:          0
```

rug-pull 命中时:
```
[.claude/mcp.json::filesystem] protocol=2025-06-18 tools=3
  - [high] mcp/tool-definition-changed: MCP 工具 "read_file" 的定义自基线起已变更——可能是 rug-pull…
  - [medium] mcp/tool-added: MCP 工具 "exfil_logs" 在基线中不存在——…
```

## 基线文件格式

`<home>/.skill-switch/mcp-scan-baseline.json`:

```json
{
  "version": 1,
  "servers": {
    ".claude/mcp.json::filesystem": {
      "read_file":   "<sha256-hex>",
      "list_dir":    "<sha256-hex>",
      "search_text": "<sha256-hex>"
    }
  }
}
```

哈希算法:`sha256(tool.name + '|' + tool.description + '|' + canonicalJson(tool.inputSchema))`,其中 `canonicalJson` 对对象 key 排序后 stringify,确保 schema 字段顺序不影响哈希。

**基线文件不含 secret**:只存工具元数据(name/description/inputSchema),不存 env VALUE、headers VALUE、命令参数值;后者已被 client.ts 排除在指纹之外。

## 退出码

| 模式 | exit code |
|---|---|
| 默认 / `--json` | 0(始终报告模式,即使有 finding) |
| `--ci` + 存在 critical/high finding | 1 |
| `--ci` + 仅 medium/low finding | 0 |
| opt-in 门拒绝(非 TTY 无 `--yes` 等) | 1 + stderr `错误: …` |
| 基线文件损坏 | 1 + stderr `错误: …` |
| 连接失败(子进程无法启动、URL 不安全) | 0(报告里单列,不阻断;`--ci` 不计入) |

## 与 `skills.lock` 的关系:为何独立

`skills.lock` 跟踪 skill 的来源/版本/commit,是"装了什么"的真相源;`mcp-scan-baseline.json` 跟踪"server 暴露什么工具给 agent",是运行时工具语义的真相源。两者是不同维度的事实:

- skill 升级可能完全不变 MCP 工具清单(无需更新 mcp-scan 基线)
- MCP server 升级可能完全不改 skill 列表(无需更新 skills.lock)

独立存储让两类扫描可以各自跑、各自回滚,不互相耦合。