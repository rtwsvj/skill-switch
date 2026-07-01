#!/usr/bin/env bash
# 打包自包含的 SkillSwitch.app(未签名)。
#   - SwiftUI release 二进制
#   - 内置自包含 SEA CLI(skill-switch-cli,无需系统 node)
#   - 应用图标
# 产物:macos/dist/SkillSwitch.app —— 交给 codesign + notarytool 签名公证(见 scripts/sign-notarize.sh)。
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(cd .. && pwd)"
APP="dist/SkillSwitch.app"
BUILD="build"
mkdir -p "$BUILD"

echo "==> 1/5 SwiftUI release 构建"
swift build -c release
BIN=".build/release/SkillSwitch"

echo "==> 2/5 自包含 SEA CLI"
CLI=$(ls "$REPO"/gui/src-tauri/bin/skill-switch-cli-* 2>/dev/null | head -1 || true)
if [ -z "${CLI:-}" ]; then
  echo "    (构建 SEA sidecar…)"
  ( cd "$REPO" && node gui/scripts/bundle-cli.mjs )
  CLI=$(ls "$REPO"/gui/src-tauri/bin/skill-switch-cli-* | head -1)
fi
echo "    CLI = $CLI"

echo "==> 3/5 应用图标"
ICNS=""
if swift scripts/make-icon.swift "$BUILD/icon.png" >/dev/null 2>&1; then
  rm -rf "$BUILD/AppIcon.iconset"; mkdir -p "$BUILD/AppIcon.iconset"
  for s in 16 32 64 128 256 512; do
    sips -z $s $s "$BUILD/icon.png" --out "$BUILD/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
    d=$((s*2)); sips -z $d $d "$BUILD/icon.png" --out "$BUILD/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  if iconutil -c icns "$BUILD/AppIcon.iconset" -o "$BUILD/AppIcon.icns" >/dev/null 2>&1; then
    ICNS="$BUILD/AppIcon.icns"; echo "    icon = $ICNS"
  fi
fi
[ -z "$ICNS" ] && echo "    (跳过图标)"

echo "==> 4/5 组装 $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/SkillSwitch"; chmod +x "$APP/Contents/MacOS/SkillSwitch"
cp "$CLI" "$APP/Contents/Resources/skill-switch-cli"; chmod +x "$APP/Contents/Resources/skill-switch-cli"
[ -n "$ICNS" ] && cp "$ICNS" "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>SkillSwitch</string>
	<key>CFBundleDisplayName</key><string>skill-switch</string>
	<key>CFBundleIdentifier</key><string>dev.skill-switch.native</string>
	<key>CFBundleExecutable</key><string>SkillSwitch</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>0.9.0</string>
	<key>CFBundleVersion</key><string>0.9.0</string>
	<key>LSMinimumSystemVersion</key><string>14.0</string>
	<key>NSPrincipalClass</key><string>NSApplication</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
$( [ -n "$ICNS" ] && echo "	<key>CFBundleIconFile</key><string>AppIcon</string>" )
	<key>LSEnvironment</key>
	<dict>
		<key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
	</dict>
</dict>
</plist>
PLIST

echo "==> 5/5 完成"
du -sh "$APP" | awk '{print "    "$0}'
echo ""
echo "未签名产物:$(pwd)/$APP"
echo "签名+公证(需 Apple Developer 凭据):见 macos/README.md 或复用 gui/scripts/sign-notarize.sh"
