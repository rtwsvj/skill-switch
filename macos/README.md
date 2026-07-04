# skill-switch —— 原生 macOS App(SwiftUI)

skill-switch 的原生 macOS 前端。**壳外调用 skill-switch CLI(`--json`)取数据,用 SwiftUI 原生视图渲染**;核心引擎(TS CLI)一行不动。取代原先的 Tauri/React GUI。

## 架构

```
SwiftUI 视图  ──▶  CLIRunner ──▶  skill-switch CLI(--json)  ──▶  Codable 解码  ──▶  原生渲染
                   (Process)      分发时用内置 SEA 二进制,开发时用 node
```

- **只读**:scan / audit / stats / doctor / restore / `mcp-scan` → 总览 · 技能 · 安全 · **MCP** · 历史 · 使用。
- **写操作**:install / toggle / remove / sync / restore / `mcp-scan --reset-baseline` → 「维护」屏 + MCP 屏 + 各屏按钮,均带**原生确认弹窗**,复用 CLI 的**装前审计 + 写前快照**护栏。
- CLI 解析顺序:`.app` 内置 `skill-switch-cli`(分发)→ `SKILL_SWITCH_CLI` → `SKILL_SWITCH_ROOT`+node(开发)→ PATH。

## 开发

```bash
# 用仓库里的 CLI(需 node)跑,指向演示目录避免碰真实配置
SKILL_SWITCH_ROOT="$(cd .. && pwd)" \
SKILL_SWITCH_HOME=/tmp/demo-home \
swift run
```

隐藏启动参数(截图/演示脚本用):`-initialScreen <overview|skills|safety|mcp|operations|history|usage>` 预选侧边栏屏;`-appLanguage <zh-Hans|en|ja|es>` 预设界面语言(经 UserDefaults 参数域,不写偏好)。

## 打包(自包含,未签名)

```bash
./build-app.sh          # → dist/skill-switch.app(内置 SEA CLI + 图标,无需 node)
open dist/skill-switch.app
```

## 签名 + 公证 + 分发(需 Apple Developer 凭据 —— 维护者手动)

> 和 CLI 的 npm 发布是两码事。要能双击分发,`.app` 必须 Developer ID 签名 + Apple 公证(和 0.8.0 卡住的是同一个 $99 门槛)。

一次性前置:装好 `Developer ID Application` 证书 + 存 notarytool 凭据(见脚本头注释),然后:

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: 你的名字 (TEAMID)" \
  ./sign-notarize.sh    # → 签名 → 公证 → 装订 → dist/skill-switch_0.9.0_aarch64.dmg
```

**权限分离**:内置 CLI(Node SEA 跑 V8)持 JIT entitlements(`entitlements-cli.plist`);SwiftUI 主程序最小权限(`entitlements-app.plist`)。

## 进度

- ✅ 里程碑 1:只读 5 屏(原生侧边栏 + 卡片 + SF Symbols + 明暗自适应)
- ✅ 里程碑 2:写操作(确认弹窗 + 快照 + 反馈横幅)
- ✅ 里程碑 3:自包含打包(内置 SEA CLI + 图标 + `build-app.sh`)
- ✅ 里程碑 4:签名/公证脚本 + entitlements(等 Apple 凭据即可分发)
- ✅ 里程碑 5:i18n 四语言(zh-Hans / en / ja / es)+ 应用内切换(toolbar globe menu)
- ✅ 里程碑 6:MCP 屏(运行时审计 + rug-pull 检测,GUI 确认即同意):第七屏,接 `mcp-scan --json`;list 模式默认只列不连,「扫描」走原生确认弹窗如实交代将启动什么进程/请求什么 URL(GUI 确认 = CLI 侧带 `--yes`);rug-pull findings 单独一组 + 「重新接受」二次确认后 `--reset-baseline`。
- ✅ 退役 `gui/`(Tauri)后把 `bundle-cli.mjs` 迁至根 `scripts/`、`release.yml` 接入原生 App 构建
