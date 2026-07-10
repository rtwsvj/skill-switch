# skill-switch 分发与部署指南

本文档以仓库中可复现的构建和发布脚本为准，不把计划中的渠道描述成已发布渠道。

## 当前支持矩阵

| 交付形式 | 平台 | 状态 | 运行时 / 签名 |
|---|---|---|---|
| npm / `npx` CLI | macOS、Linux、Windows | 当前 CLI 安装路径 | Node.js 20+ |
| 源码 CLI | macOS、Linux、Windows | 支持 | Node.js 20+ 和 pnpm 10 |
| 原生 SwiftUI App 源码构建 | macOS 14+ | 支持，只构建当前 Mac 的 CPU 架构 | 未签名 |
| tag workflow 的 `skill-switch.app.zip` | macOS 14+ | 自动构建的预览产物 | 未签名，可能被 Gatekeeper 拦截 |
| Developer ID 签名 + Apple 公证 DMG | macOS 14+ | 可选的人工发布步骤 | 只有实际执行并验证后才能宣称已签名 |
| Homebrew tap / Scoop / MSI / AppImage / deb | 多平台 | **planned，当前不可安装** | 当前 release workflow 不产出这些文件 |

`@rtwsvj/skill-switch` 定位为 **CLI 包**。它不承诺 `import '@rtwsvj/skill-switch'` 这样的 Node 库 API；受支持的入口是 `skill-switch` / `npx @rtwsvj/skill-switch`。

## npm / npx CLI

无需全局安装：

```bash
npx @rtwsvj/skill-switch --help
npx @rtwsvj/skill-switch audit --configs
```

或全局安装 CLI：

```bash
npm install -g @rtwsvj/skill-switch
skill-switch --version
skill-switch audit --configs
```

发布前必须对 `npm pack` 生成的 tarball 做干净 Node 20/22 环境的安装、`--version`、`--help` 和一个实际 audit 冒烟。`npm pack --dry-run` 只能证明文件被打包，不能证明安装后可运行。

## 从源码构建 macOS App

需要 macOS 14+、Xcode Command Line Tools / Swift 6、Node.js 20+ 和 pnpm 10：

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm release
```

`pnpm release` 生成 `macos/dist/skill-switch.app`，此产物默认**未签名**。`macos/build-app.sh` 会：

1. 从 `package.json` 读取版本号；
2. 重新构建当前 host triple 的 Node SEA CLI；
3. 拒绝架构不匹配的 Swift / SEA 产物；
4. 比对 package、CLI 和 Info.plist 版本；
5. 组装只包含当前 host 架构的 `.app`。

它不会从 `dist/sea/` 随便取第一个旧 sidecar。

## 未签名与签名产物

`.github/workflows/release.yml` 在 tag 触发时构建并上传 `skill-switch.app.zip`。该 workflow 没有 Apple 签名凭据，因此这个 zip 是未签名预览产物。

如果维护者持有 Developer ID，可在干净的 macOS 机器上执行：

```bash
cd macos
APPLE_SIGNING_IDENTITY="Developer ID Application: <identity>" ./sign-notarize.sh
```

只有同时通过以下验证的 DMG 才可标记为签名公证版：

```bash
codesign --verify --deep --strict --verbose=2 /path/to/skill-switch.app
spctl --assess --type execute --verbose=2 /path/to/skill-switch.app
xcrun stapler validate /path/to/skill-switch.app
shasum -a 256 /path/to/skill-switch_*.dmg
```

某个 Release 是否包含已签名 DMG，应以该 Release 的实际 assets 和校验记录为准，不能从版本号推断。完整步骤见 [release/signing.md](./release/signing.md)。

## 计划中但尚未启用的渠道

- `packaging/skill-switch.rb` 是一个明确标记为 `NOT INSTALLABLE` 的 Homebrew 计划说明，不是 Formula。
- `packaging/skill-switch.json` 是 `installable: false` 的 Scoop 计划元数据，不是 Scoop manifest。
- 当前没有由本仓库发布的 MSI、Windows 独立 exe、AppImage 或 deb。
- 不应向 tap/bucket 复制这两个计划文件。

启用一个渠道前，必须先具备真实产物、稳定 URL、SHA-256、安装/升级/卸载测试和对应的 tap/bucket。

## 维护者发布检查表

1. 确认工作区和版本变更范围。
2. 运行 typecheck、lint、全量 tests 和 coverage。
3. 生成 npm tarball，在干净 Node 20/22 环境安装冒烟。
4. 在目标 Mac 上构建 `.app`，记录 host triple、架构、CLI 版本和 Info.plist 版本。
5. 将未签名 zip 明确标记为 preview；不得描述为 notarized。
6. 如果发布签名 DMG，保存 codesign、Gatekeeper、stapler 和 checksum 证据。
7. 只发布实际在当前 tag 构建、测试和校验过的渠道。

`bun compile` 仍是开发实验，不属于当前 App 或 release workflow 的交付合同。
