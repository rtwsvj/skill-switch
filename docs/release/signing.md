# 签名与公证指南(macOS 分发)

> 目标:把原生 SwiftUI 桌面 App(`macos/dist/skill-switch.app`)打成**经你的 Developer ID 签名 + Apple 公证**的可分发 `.dmg`,别人下载后 Gatekeeper 不拦。

## 0. 前置(已确认就绪)

本机已具备签名三要素(`security find-identity` / `notarytool history` 核实):

| 要素 | 状态 |
|---|---|
| Developer ID 证书 | ✅ `Developer ID Application: Fengyin Zhang (8QQ823QM99)`(Team ID `8QQ823QM99`) |
| notarytool keychain profile | ✅ `skill-switch-notary`(已配置) |
| Xcode 命令行工具 | ✅ `/Library/Developer/CommandLineTools` |

> 这些是**一次性**配置,已完成。签名命令用的是 keychain 里的身份与 profile,**不需要再输 Apple 密码**。

## 1. 一条命令出包

```bash
cd macos
APPLE_SIGNING_IDENTITY="Developer ID Application: Fengyin Zhang (8QQ823QM99)" \
  ./sign-notarize.sh
```

脚本(`macos/sign-notarize.sh`)做 6 步:
1. `macos/build-app.sh` 重新打包未签名的 `macos/dist/skill-switch.app`(SwiftUI release + 内置 SEA CLI + 图标)。
2. `codesign --options runtime --timestamp --entitlements entitlements-cli.plist` 给内置 CLI(`Contents/Resources/skill-switch-cli`,跑 V8 的 Node SEA sidecar)发 JIT entitlements。
3. `codesign` 给 SwiftUI 主程序(`Contents/MacOS/SkillSwitch`)与整个 `.app` 发最小 entitlements(`entitlements-app.plist`)。
4. `hdiutil create` 打 `.dmg`,并对 `.dmg` 单独签名。
5. `notarytool submit --wait` 提交公证,等 Apple 处理。
6. `stapler staple` 把公证票据装订进 `.app` 与 `.dmg`(离线也能验证),`spctl` + `stapler validate` 做 Gatekeeper 校验。

成功后产物:`macos/dist/skill-switch_0.9.0_aarch64.dmg`。

## 2. 跑的时候会发生什么(预期)

- **耗时**:SwiftUI release 构建 + 上传公证 + Apple 处理,通常 **3–10 分钟**(无 Rust 编译,比 Tauri 时代快很多)。
- **可能弹一次 keychain 对话框**:首次让 `codesign` 用 Developer ID 私钥时,macOS 可能弹「codesign 想使用你 keychain 里的密钥」——点 **始终允许 / Always Allow**。这一步需要你在机器前点一下(自动化无法替你点这个安全对话框)。
- **联网**:第 5 步会把构建产物上传给 Apple 公证服务。
- arm64-only(Apple Silicon);universal 需 x86_64 工具链交叉编译,未做。

## 3. 验证(脚本已含,亦可单跑)

```bash
APP="macos/dist/skill-switch.app"
spctl -a -t exec -vv "$APP"          # 期望 source=Notarized Developer ID
xcrun stapler validate "$APP"        # 期望 The validate action worked!
```

## 4. entitlement 分离(已默认做)

**设计**:`sign-notarize.sh` 把内置 CLI(`Contents/Resources/skill-switch-cli`)和 SwiftUI 主程序(`Contents/MacOS/SkillSwitch`)分别签,**绝不让主程序带它不需要的 JIT**:

| 二进制 | 路径 | entitlements |
|---|---|---|
| SwiftUI 主程序 | `Contents/MacOS/SkillSwitch` | `entitlements-app.plist`(最小,无 JIT) |
| 内置 CLI(SEA) | `Contents/Resources/skill-switch-cli` | `entitlements-cli.plist`(JIT,跑 V8) |

`.app` 与 `.dmg` 本身用 `entitlements-app.plist`(最小)再签一次。这套分离已经是默认行为,不需要额外手工干预。

## 5. 排错
- `errSecInternalComponent` / 签名失败:keychain 私钥 ACL 没允许 codesign → 重跑并在弹窗点「始终允许」。
- 公证 `Invalid`:`xcrun notarytool log <submission-id> --keychain-profile skill-switch-notary` 看具体原因(常见:某内嵌二进制没签 / 没开 hardened runtime)。
- `spctl` 显示 `rejected`:多半是公证票据没装订成功,重跑第 6 步 `stapler staple`。
- SwiftUI 编译失败 / 找不到 `SkillSwitch` 二进制:先 `cd macos && swift build -c release` 单独跑一遍,把 `swift` 工具链报错先排掉,再跑 `sign-notarize.sh`。
