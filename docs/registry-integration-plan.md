# C 线:Registry / 市场接入设计 / Registry Integration

> 让 skill-switch 能从外部注册表**只读搜索**并**经审计后安装** skill / MCP server,补齐"生态接入"短板(对标 ccpi / APM marketplace)。
> 配套:[docs/best-of-breed-plan.md](best-of-breed-plan.md)(C 线)、[docs/competitive-landscape.md](competitive-landscape.md)。

## 0. 安全原则(不可协商)

这是个**本地优先、零遥测**的安全工具。C 的网络接入必须**安全自带**,即使没有逐次人工批准也守得住:

1. **纯 opt-in**:默认零网络。只有用户**显式**运行 `registry` 命令(或带 `--registry` 标志)时才联网。任何其它命令(audit/status/doctor/sync…)永不因 C 而联网。
2. **零遥测**:除用户主动触发的那一次搜索/拉取请求外,**不发任何数据**;不带 user-agent 指纹、不带凭据、不带本机信息;不上报使用情况。
3. **装前必审、绝不执行**:从注册表拿到的任何 skill,在落盘前一律走现有审计引擎(`auditContents`);DANGER 默认拦截(`--force` + 留痕才放行)。**绝不执行**注册表内容里的任何命令/脚本(沿用 `add` 姿态)。
4. **仅 HTTPS**:拒绝 http://;校验响应 content-type 为 JSON;响应体大小上限(防超大响应 DoS)。
5. **零新依赖**:用 Node 内置 `fetch` + `JSON.parse`,不引 HTTP 客户端 / SDK。
6. **测试零真实网络**:单测全程 mock fetch,加"零 TCP / 零 fetch"哨兵(沿用 D apm-interop 的做法);真实网络只在端用户运行命令时发生。

## 1. 接入源(范围收敛)

只接**有稳定、文档化、免鉴权读接口**的源;不抓聚合站 HTML(脆弱、不可信)。

| 源 | 接口 | 状态 | 本期 |
|---|---|---|---|
| **官方 MCP Registry** | `https://registry.modelcontextprotocol.io` REST(`GET /v0/servers?search=…`),v0 已冻结、读免鉴权 | 稳定、文档化 | ✅ 做 |
| **`marketplace.json` 清单** | Claude Code 市场标准:GitHub 托管的 `.claude-plugin/marketplace.json`(如 `anthropics/skills`),raw.githubusercontent 拉取 JSON | 标准、稳定 | ✅ 做 |
| **SkillsMP** | REST `GET /api/v1/skills/search?q=…`([文档](https://skillsmp.com/docs/api)),**需 Bearer token 鉴权** | 有文档,但需鉴权 | ✅ 做(见 §1.1) |
| Clawdhub / claudemarketplaces | 无公开 API(目录站) | 无 API | ❌ 不抓 HTML |

### 1.1 SkillsMP —— opt-in + 用户自带 token 的例外

SkillsMP 是唯一**需鉴权**的源,与"免鉴权"原则冲突,故按最严格方式接入,守住零凭据/零遥测底线:

- **严格 opt-in**:仅当用户设了环境变量 `SKILLSMP_TOKEN`(在 skillsmp.com 自行申请)**且**该源被查询时才启用;未设 token 则该源被**跳过**并提示,不影响其它源、不联网。
- **token 全程用户自带**:skill-switch **绝不内置、绝不存储、绝不写日志**;token 只经 `fetch.ts` 的 `bearerToken` 附加进 `Authorization` 请求头,**只进 header 不进 URL**(故不会出现在任何错误信息里),**只发往 `skillsmp.com`**(HTTPS)。
- **不进命令行**:token 只从环境变量读,不做成 CLI 参数(避免进 shell history)。
- 其余(HTTPS-only、限时限大小、装前必审、绝不执行)与另两源一致。

## 2. 命令 UX(新建独立 `registry` 命令,不动 add/packs 核心)

```
skill-switch registry search <query> [--source mcp|marketplace] [--marketplace <owner/repo>] [--json]
    只读搜索:列出匹配的 skill/server(名称、描述、来源、仓库 URL)。默认两源都查。
skill-switch registry install <id> [--source …] [--agents …] [--force] [--dry-run]
    取该条目 → 解析来源(GitHub 仓库/包)→ **审计** → dry-run 预览或经现有 add/install 安装。
    DANGER 默认拦截;--force + 理由 留痕放行。
```

- `search` 纯只读,不写盘。`install` 默认 dry-run 友好,实际写盘复用现有审计+快照+安装路径。
- 无任何 registry 子命令被调用时:**零网络**。

## 3. 文件归属(实现契约)

| 模块 | 文件 | 说明 |
|---|---|---|
| HTTP 取数(opt-in、HTTPS-only、限流限大小、零遥测) | `src/core/registry/fetch.ts` | 内置 fetch 封装 + 哨兵友好 |
| MCP Registry 客户端 | `src/core/registry/mcp-registry.ts` | `searchServers(query)` → 归一化条目 |
| marketplace.json 客户端 | `src/core/registry/marketplace.ts` | 拉取 + 解析 `.claude-plugin/marketplace.json` → 归一化条目 |
| 归一化类型 + 聚合搜索 | `src/core/registry/index.ts` | `RegistryEntry`、`searchRegistries()` |
| CLI 命令 | `src/cli/commands/registry.ts` | `registry search/install`;install 复用 `add` 的解析→审计→安装 |
| 测试(全程 mock fetch + 网络哨兵) | `tests/registry-*.test.ts` | 零真实网络 |
| 接线(编排者) | `src/cli/program.ts` | 注册命令,helpGroup「集成」 |

## 4. 明确不做(本期)

- 不抓任何聚合站 HTML;不接无文档 API。
- 不做发布/上传到注册表(只读 + 装)。
- 不缓存远端数据到磁盘(除非用户 `install`,且只落审计通过的 skill)。
- 不在 audit/status/doctor 等命令里隐式联网。

## 5. 用户授权说明

用户已授权代办逐端点决定(本人表示看不懂、不必逐条批准)。据此按上述**最保守安全默认**实现,并以大白话告知:**本功能只在你主动运行 `registry` 命令时,向 `registry.modelcontextprotocol.io` 或你指定的 GitHub 市场仓库发只读请求;装任何东西前先安全审计;绝不执行远端命令、绝不上报你的数据。**
