# 签名与公证指南(macOS 分发)

> 目标:把 GUI 打成**经你的 Developer ID 签名 + Apple 公证**的可分发 `.dmg`,别人下载后 Gatekeeper 不拦。

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
APPLE_SIGNING_IDENTITY="Developer ID Application: Fengyin Zhang (8QQ823QM99)" \
  pnpm --dir gui sign
```

脚本(`gui/scripts/sign-notarize.sh`)做 4 步:
1. `tauri build`(Developer ID 签名 + hardened runtime)→ 产出 `skill-switch.app` 与 `.dmg`。
2. `notarytool submit --wait` 提交公证,等 Apple 处理。
3. `stapler staple` 把公证票据装订进 `.app` 与 `.dmg`(离线也能验证)。
4. `spctl` + `stapler validate` 做 Gatekeeper 校验。

成功后产物:`gui/src-tauri/target/release/bundle/dmg/skill-switch_<ver>_aarch64.dmg`。

## 2. 跑的时候会发生什么(预期)

- **耗时**:Rust release 构建 + 上传公证 + Apple 处理,通常 **5–15 分钟**。
- **可能弹一次 keychain 对话框**:首次让 `codesign` 用 Developer ID 私钥时,macOS 可能弹「codesign 想使用你 keychain 里的密钥」——点 **始终允许 / Always Allow**。这一步需要你在机器前点一下(自动化无法替你点这个安全对话框)。
- **联网**:第 2 步会把构建产物上传给 Apple 公证服务。
- arm64-only(Apple Silicon);universal 需 x86_64 工具链交叉编译,未做。

## 3. 验证(脚本已含,亦可单跑)

```bash
APP="gui/src-tauri/target/release/bundle/macos/skill-switch.app"
spctl -a -t exec -vv "$APP"          # 期望 source=Notarized Developer ID
xcrun stapler validate "$APP"         # 期望 The validate action worked!
```

## 4.(可选加固)entitlement 分离 —— 主程序去掉 JIT

**现状**:`tauri.conf.json` → `bundle.macOS.entitlements: "entitlements.plist"`(合并版,给整个 app 发 JIT)。能正常签名+公证,但**主程序也带了它并不需要的 JIT**(WKWebView 的 JS JIT 由系统的 WebContent 进程负责,主进程无需 `allow-jit`;真正需要 JIT 的只有跑 V8 的 Node SEA sidecar)。

**为什么没默认做**:Tauri 在 bundle 阶段一次性签 `.app` 并打 `.dmg`,无法对内嵌的 sidecar 二进制单独发 entitlements。要做分离,需在 `tauri build` 之后、公证之前**对 sidecar 单独重签、再重建 DMG**——这步在没有证书的环境里无法测试,故未塞进脚本。

**想做时的精确配方**(建议你在机器前、证书在手时跑一次验证):
```bash
ID="Developer ID Application: Fengyin Zhang (8QQ823QM99)"
APP=gui/src-tauri/target/release/bundle/macos/skill-switch.app
# 1) tauri.conf 改指向最小 entitlements(无 JIT):bundle.macOS.entitlements = "entitlements-app.plist"
# 2) tauri build 后,先给 sidecar 重签 JIT:
codesign --force --options runtime --timestamp \
  --entitlements gui/src-tauri/entitlements-sidecar.plist \
  --sign "$ID" "$APP/Contents/MacOS/skill-switch-cli"
# 3) 再对 .app 重签 + 重新封签(不 --deep,保留 sidecar 自己的签名):
codesign --force --options runtime --timestamp \
  --entitlements gui/src-tauri/entitlements-app.plist \
  --sign "$ID" "$APP"
# 4) 用重签后的 .app 重新生成 .dmg(create-dmg / hdiutil),再走公证。
# 5) 验证分离:
pnpm --dir gui check:entitlements   # 期望:✓ 主程序最小,sidecar 持 JIT
```

> 判断:对「给朋友体验」的早期版本,**先用合并 entitlements 出一个能跑、能公证的包**即可;分离是后续加固,等你有空在机器前测一轮再切。

## 5. 排错
- `errSecInternalComponent` / 签名失败:keychain 私钥 ACL 没允许 codesign → 重跑并在弹窗点「始终允许」。
- 公证 `Invalid`:`xcrun notarytool log <submission-id> --keychain-profile skill-switch-notary` 看具体原因(常见:某内嵌二进制没签 / 没开 hardened runtime)。
- `spctl` 显示 `rejected`:多半是公证票据没装订成功,重跑第 3 步 `stapler staple`。
