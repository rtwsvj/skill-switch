#!/usr/bin/env bash
# i18n 校验:四份 Localizable.strings key 集合一致、无重复、所有 t("...") 引用都已定义、未引用的 key 仅警告。
# 零新依赖,纯 bash/grep/awk/sort;兼容 macOS bash 3.2(无关联数组)。
#
# (a) 四个 Localizable.strings 的 key 集合完全一致
# (b) 任一文件内无重复 key
# (c) Sources/ 里所有 t("...") 引用的 key 都在 zh-Hans.strings 里有定义
# (d) 定义了但没被引用的 key 只 warning 不失败
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="Sources/SkillSwitch"
RES="$ROOT/Resources"
LANGS=(zh-Hans en ja es)

fail=0
warn=0

# 临时目录(脚本退出时清掉)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 从 .strings 提取所有 key(去 /* */ 注释行),每行一个,有序。
extract_keys() {
    local f="$1"
    sed -E 's|/\*[^*]*\*+([^/*][^*]*\*+)*/||g' "$f" \
      | grep -oE '^"[^"]+"[ \t]*=' \
      | sed -E 's/^"([^"]+)"[ \t]*=[ \t]*/\1/' \
      | sort
}

echo "==> (a)+(b) 检查四份 .strings 的 key 集合..."
ref_n=0
for lang in "${LANGS[@]}"; do
    f="$RES/$lang.lproj/Localizable.strings"
    if [ ! -f "$f" ]; then
        echo "  ✗ 缺失文件: $f" >&2
        fail=1
        continue
    fi
    extract_keys "$f" > "$TMP/$lang.keys"

    # (b) 重复 key 检测
    total=$(wc -l < "$TMP/$lang.keys" | tr -d ' ')
    uniq_n=$(uniq < "$TMP/$lang.keys" | wc -l | tr -d ' ')
    if [ "$total" != "$uniq_n" ]; then
        echo "  ✗ $f 含重复 key:" >&2
        uniq -d < "$TMP/$lang.keys" | sed 's/^/    /' >&2
        fail=1
    fi

    [ "$lang" = "zh-Hans" ] && ref_n=$total
done

# (a) 四份 key 集合一致
inconsistent=0
for lang in "${LANGS[@]}"; do
    if [ "$lang" = "zh-Hans" ]; then continue; fi
    if ! cmp -s "$TMP/zh-Hans.keys" "$TMP/$lang.keys"; then
        echo "  ✗ $lang.lproj/Localizable.strings 与 zh-Hans key 集合不一致:" >&2
        diff "$TMP/zh-Hans.keys" "$TMP/$lang.keys" | sed 's/^/    /' >&2
        fail=1
        inconsistent=1
    fi
done

if [ $inconsistent -eq 0 ] && [ $fail -eq 0 ]; then
    echo "    ✓ 四份 .strings key 集合完全一致,无重复 ($ref_n 个 key)"
fi

# (c) 引用 → zh-Hans 必须有
echo "==> (c) 检查 Sources/ 里所有 t(\"...\") 引用..."

# 策略:从所有 Swift 源里提取形如 "x.y.z" 的字符串字面量 —— 但只保留以已知 key namespace 开头的。
# 这条过滤把 SF Symbol (arrow.clockwise 等)、CLI flag (--json 等)、Picker tag (copy 等) 排除掉,
# 因为它们不是以 nav./status./ops./... 这些 namespace 开头的。
# 用 namespace 名单从 zh-Hans.keys 自动推导,新增 namespace 不用改脚本。
grep -hoE '^"[^"]+"\s*=' "$RES/zh-Hans.lproj/Localizable.strings" \
    | sed -E 's/^"([^".]+)\..*/\1./' \
    | sort -u > "$TMP/ns.keys"

NS_PATTERN=$(awk '{ printf "%s|", $0 }' "$TMP/ns.keys" | sed 's/|$//')

grep -hoE '"[a-z][a-zA-Z]*(\.[a-zA-Z][a-zA-Z]+)+"' "$ROOT"/*.swift "$ROOT"/Views/*.swift 2>/dev/null \
    | tr -d '"' \
    | grep -E "^(${NS_PATTERN})" \
    | sort -u > "$TMP/refs.keys"

missing=0
while IFS= read -r k; do
    [ -z "$k" ] && continue
    if ! grep -qxF "$k" "$TMP/zh-Hans.keys"; then
        echo "  ✗ 引用了未定义的 key: $k" >&2
        missing=1
    fi
done < "$TMP/refs.keys"

if [ $missing -eq 0 ]; then
    ref_total=$(wc -l < "$TMP/refs.keys" | tr -d ' ')
    echo "    ✓ 所有 $ref_total 个 t(\"...\") 引用都已在 zh-Hans.strings 定义"
else
    fail=1
fi

# (d) 已定义但未引用 → warning
echo "==> (d) 检查未使用的 key(仅警告)..."
comm -23 "$TMP/zh-Hans.keys" "$TMP/refs.keys" > "$TMP/unused.keys"
if [ -s "$TMP/unused.keys" ]; then
    echo "    ⚠ 以下 key 已定义但未在 Sources/ 中引用:"
    sed 's/^/      - /' "$TMP/unused.keys"
    warn=1
else
    echo "    ✓ 全部 key 都已被引用"
fi

echo ""
if [ $fail -ne 0 ]; then
    echo "✗ i18n 校验失败" >&2
    exit 1
fi
if [ $warn -ne 0 ]; then
    echo "✓ i18n 校验通过(有 warning)"
else
    echo "✓ i18n 校验全部通过"
fi