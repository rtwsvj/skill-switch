#!/usr/bin/env bash
# SkillSwitch.app 签名 + 公证 + 装订 + 打 DMG(macOS 分发)。脚本不碰你的密码。
#
# 一次性前置(你自己做):
#   1) 有 Apple Developer Program 会员($99/年),keychain 里装好
#      "Developer ID Application: 你的名字 (TEAMID)" 证书(developer.apple.com 下载)。
#   2) 存 notarytool 凭据 profile(交互式,只做一次):
#        xcrun notarytool store-credentials skill-switch-notary \
#          --apple-id <你的AppleID邮箱> --team-id <你的TeamID>
#
# 用法:
#   APPLE_SIGNING_IDENTITY="Developer ID Application: 你的名字 (TEAMID)" ./macos/sign-notarize.sh
#
# 可选:NOTARY_PROFILE(默认 skill-switch-notary)、SKIP_BUILD=1(跳过重新打包)
set -euo pipefail
: "${APPLE_SIGNING_IDENTITY:?请设 APPLE_SIGNING_IDENTITY 为你的 'Developer ID Application: …' 身份}"
NOTARY_PROFILE="${NOTARY_PROFILE:-skill-switch-notary}"
cd "$(dirname "$0")"

APP="dist/SkillSwitch.app"
CLI="$APP/Contents/Resources/skill-switch-cli"
DMG="dist/skill-switch_0.9.0_aarch64.dmg"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "==> 0/6 打包(未签名)"
  ./build-app.sh
fi

echo "==> 1/6 签名内置 CLI(hardened runtime + JIT entitlements)"
codesign --force --options runtime --timestamp \
  --entitlements entitlements-cli.plist \
  --sign "$APPLE_SIGNING_IDENTITY" "$CLI"

echo "==> 2/6 签名 App 主程序(hardened runtime,最小 entitlements)"
codesign --force --options runtime --timestamp \
  --entitlements entitlements-app.plist \
  --sign "$APPLE_SIGNING_IDENTITY" "$APP/Contents/MacOS/SkillSwitch"

echo "==> 3/6 签名整个 .app 包"
codesign --force --options runtime --timestamp \
  --entitlements entitlements-app.plist \
  --sign "$APPLE_SIGNING_IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "==> 4/6 打 DMG"
rm -f "$DMG"
hdiutil create -volname "skill-switch" -srcfolder "$APP" -ov -format UDZO "$DMG"
codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG"

echo "==> 5/6 提交公证(等 Apple 处理,几分钟)"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait

echo "==> 6/6 装订票据 + Gatekeeper 校验"
xcrun stapler staple "$APP"
xcrun stapler staple "$DMG"
spctl -a -t exec -vv "$APP"
xcrun stapler validate "$DMG"

echo ""
echo "✓ 已签名 + 公证 + 装订:$(pwd)/$DMG"
echo "  用户双击即可打开,不会被 Gatekeeper 拦。"
