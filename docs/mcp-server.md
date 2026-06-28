# skill-switch 作为 MCP server

把 skill-switch 跑成一个 [MCP](https://modelcontextprotocol.io)(Model Context Protocol)server,让 **Cursor / Claude Code / Claude Desktop** 等 agent 在对话里**实时调用**它的安全审计能力——比如"帮我审一下这个 skill 安不安全""我现在装了哪些 skill、有没有漂移"。

> **安全边界:MCP 这条路只读。** 暴露给 agent 的工具全部是只读的(盘点 / 现状 / 审计),**绝不经此修改你的磁盘或配置**。安装、同步、回滚这类写操作仍只走显式的 CLI / GUI(且都先快照)。

## 它是什么

- **零依赖**:用手写的 MCP stdio(JSON-RPC 2.0)实现,不引入任何 MCP SDK 依赖,与 skill-switch 一贯的 zero-dep / local-first 一致。
- **本机、离线**:server 跑在你本机,读你本机的 skill 与配置,不联网、无遥测。

## 暴露的工具

所有工具均标注 `readOnlyHint: true, destructiveHint: false, idempotentHint: true`,客户端(如 Claude Desktop / Cursor)可自动批准这些调用,无需每次弹窗确认。

| 工具 | 作用 | 入参 |
|---|---|---|
| `skill_switch_scan` | 盘点各 agent 已安装的 skill | `home?`(覆盖 home 根目录) |
| `skill_switch_status` | 一眼看现状:磁盘/声明/启用/锁定 数、检测到的 agent、健康状态 | `home?` |
| `skill_switch_audit` | 安全审计(80+ 规则:反向 shell、数据外泄、凭据钓鱼、危险 MCP、明文传输、硬编码密钥…) | `path?`(审单个 skill 目录)、`home?`、`includeConfigs?`(审整个 home 时连配置一起) |
| `skill_switch_packs_suggest` | 分析 skill 共现情况,建议组成套餐 | `home?`、`windowDays?` |
| `skill_switch_stats` | 统计 skill 使用频率 + 找出僵尸 skill | `home?`、`days?` |

随时可以本地查看:

```bash
skill-switch mcp --list-tools
```

## 内置 Resources(规则知识库)

agent 可以用 `resources/read` 把规则知识库载入上下文:

| URI | 内容 |
|---|---|
| `skill-switch://rules` | 内置审计规则类目(14 类,含 id、标签、描述),JSON 格式。 |
| `skill-switch://report/last` | 说明:MCP server 无状态,实时报告请调用工具。 |

## 内置 Prompts(审计模板)

`prompts/list` + `prompts/get` 提供 3 条开箱即用的审计模板:

| Prompt | 用途 |
|---|---|
| `audit-all-skills` | 审计本机所有 skill,列出风险最高的 5 个并给处置建议。 |
| `find-zombie-skills` | 找出近期零触发的僵尸 skill,建议禁用/删除节省 token 配额。 |
| `audit-single-skill` | 深度审计指定 skill 目录,逐条列出 finding + 安全结论。 |

## 接入 Claude Code

用 npx(无需本地安装):

```bash
claude mcp add skill-switch -- npx -y @rtwsvj/skill-switch mcp
```

或手写进项目级 `.mcp.json` / 用户级配置:

```json
{
  "mcpServers": {
    "skill-switch": {
      "command": "npx",
      "args": ["-y", "@rtwsvj/skill-switch", "mcp"]
    }
  }
}
```

若已把 CLI 链接到 PATH(见 README「CLI」一节),可直接:

```json
{
  "mcpServers": {
    "skill-switch": { "command": "skill-switch", "args": ["mcp"] }
  }
}
```

## 接入 Cursor

编辑 `~/.cursor/mcp.json`(或项目 `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "skill-switch": {
      "command": "npx",
      "args": ["-y", "@rtwsvj/skill-switch", "mcp"]
    }
  }
}
```

接好后,在对话里直接让 agent 用即可,例如:

> 用 skill-switch 审一下 `./my-skill` 安不安全。
>
> 我现在装了哪些 skill?有没有和声明对不上的?

## 协议细节

- 传输:stdio,行分隔 JSON-RPC 2.0。`stdout` 仅承载协议帧,启动横幅与诊断走 `stderr`。
- 协议版本:`2025-06-18`(上一版 `2024-11-05` 的超集,完全向后兼容)。
- 支持的方法:`initialize`、`tools/list`、`tools/call`、`ping`、`resources/list`、`resources/read`、`prompts/list`、`prompts/get`,以及 `notifications/initialized` 等通知。

手动验证一把:

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"resources/list"}' \
  | skill-switch mcp
```
