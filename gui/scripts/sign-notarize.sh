#!/usr/bin/env bash
# 签名 + 公证 + 装订 + 校验 一键流程(macOS 分发用)。
#
# 前置(各自一次性准备,脚本不碰你的密码):
#   1) keychain 里有 "Developer ID Application: …" 身份(developer.apple.com 下载安装)。
#   2) 已存 notarytool keychain profile:
#        xcrun notarytool store-credentials "$NOTARY_PROFILE" \
#          --apple-id <你的AppleID邮箱> --team-id <你的TeamID>
#
# 用法:
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
#     pnpm --dir gui sign
#
# 可选环境变量:
#   NOTARY_PROFILE  notarytool keychain profile 名(默认 skill-switch-notary)
set -euo pipefail

: "${APPLE_SIGNING_IDENTITY:?请设置 APPLE_SIGNING_IDENTITY 为你的 'Developer ID Application: …' 身份}"
NOTARY_PROFILE="${NOTARY_PROFILE:-skill-switch-notary}"

cd "$(dirname "$0")/.."  # → gui/

echo "==> 1/4 用 Developer ID 构建签名包"
APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" pnpm tauri build

APP="src-tauri/target/release/bundle/macos/skill-switch.app"
DMG="$(ls -1 src-tauri/target/release/bundle/dmg/*.dmg | head -1)"

echo "==> 2/4 提交公证(等待 Apple 处理)"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait

echo "==> 3/4 装订票据(.app 与 .dmg)"
xcrun stapler staple "$APP"
xcrun stapler staple "$DMG"

echo "==> 4/4 Gatekeeper 校验"
spctl -a -t exec -vv "$APP"
spctl -a -t open --context context:primary-signature -vv "$DMG"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"

echo "✓ 已签名 + 公证 + 装订:$DMG"
