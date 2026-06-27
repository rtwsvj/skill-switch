# skill-switch 作为 MCP server

把 skill-switch 跑成一个 [MCP](https://modelcontextprotocol.io)(Model Context Protocol)server,让 **Cursor / Claude Code / Claude Desktop** 等 agent 在对话里**实时调用**它的安全审计能力——比如"帮我审一下这个 skill 安不安全""我现在装了哪些 skill、有没有漂移"。

> **安全边界:MCP 这条路只读。** 暴露给 agent 的工具全部是只读的(盘点 / 现状 / 审计),**绝不经此修改你的磁盘或配置**。安装、同步、回滚这类写操作仍只走显式的 CLI / GUI(且都先快照)。

## 它是什么

- **零依赖**:用手写的 MCP stdio(JSON-RPC 2.0)实现,不引入任何 MCP SDK 依赖,与 skill-switch 一贯的 zero-dep / local-first 一致。
- **本机、离线**:server 跑在你本机,读你本机的 skill 与配置,不联网、无遥测。

## 暴露的工具

| 工具 | 作用 | 入参 |
|---|---|---|
| `skill_switch_scan` | 盘点各 agent 已安装的 skill | `home?`(覆盖 home 根目录) |
| `skill_switch_status` | 一眼看现状:磁盘/声明/启用/锁定 数、检测到的 agent、健康状态 | `home?` |
| `skill_switch_audit` | 安全审计(80+ 规则:反向 shell、数据外泄、凭据钓鱼、危险 MCP、明文传输、硬编码密钥…) | `path?`(审单个 skill 目录)、`home?`、`includeConfigs?`(审整个 home 时连配置一起) |

随时可以本地查看:

```bash
skill-switch mcp --list-tools
```

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
- 协议版本:`2024-11-05`。
- 支持的方法:`initialize`、`tools/list`、`tools/call`、`ping`,以及 `notifications/initialized` 等通知。

手动验证一把:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | skill-switch mcp
```
