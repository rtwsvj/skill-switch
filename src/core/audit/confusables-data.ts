// Unicode 同形字映射表(扩展版)
// 来源:Unicode TR39 confusables 高价值子集 + 常见供应链攻击实际使用的字符集
// 覆盖:Cyrillic 全集、希腊字母、全角 ASCII、常见 Latin lookalike
// 用途:替换 engine.ts 中原始的 HOMOGLYPH_MAP,引擎逻辑不变,仅扩充数据表。
// 硬编码,不联网,无依赖。
//
// 条目格式:[confusable 字符, 目标 ASCII 字符]
// 目标字符统一为可打印 ASCII(大小写均保留,不做大小写折叠)。

export const CONFUSABLES_MAP: ReadonlyMap<string, string> = new Map<string, string>([
  // ── Cyrillic 小写 ──────────────────────────────────────────────────────────
  // 原始 18 条全部保留,再补充剩余 Cyrillic 同形字
  ['с', 'c'],  // U+0441 CYRILLIC SMALL LETTER ES
  ['е', 'e'],  // U+0435 CYRILLIC SMALL LETTER IE
  ['о', 'o'],  // U+043E CYRILLIC SMALL LETTER O
  ['а', 'a'],  // U+0430 CYRILLIC SMALL LETTER A
  ['р', 'p'],  // U+0440 CYRILLIC SMALL LETTER ER
  ['х', 'x'],  // U+0445 CYRILLIC SMALL LETTER HA
  ['і', 'i'],  // U+0456 CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I
  ['ѕ', 's'],  // U+0455 CYRILLIC SMALL LETTER DZE
  ['ј', 'j'],  // U+0458 CYRILLIC SMALL LETTER JE
  ['ӏ', 'l'],  // U+04CF CYRILLIC SMALL LETTER PALOCHKA → l
  ['ԁ', 'd'],  // U+0501 CYRILLIC SMALL LETTER KOMI DE
  ['ԛ', 'q'],  // U+051B CYRILLIC SMALL LETTER QA
  ['ԝ', 'w'],  // U+051D CYRILLIC SMALL LETTER WE
  ['ʏ', 'y'],  // U+028F LATIN LETTER SMALL CAPITAL Y (sometimes confused with Cyrillic)
  ['υ', 'u'],  // U+03C5 GREEK SMALL LETTER UPSILON (often confused with u)
  ['ν', 'v'],  // U+03BD GREEK SMALL LETTER NU

  // ── Cyrillic 大写 ──────────────────────────────────────────────────────────
  ['А', 'A'],  // U+0410 CYRILLIC CAPITAL LETTER A
  ['В', 'B'],  // U+0412 CYRILLIC CAPITAL LETTER VE
  ['С', 'C'],  // U+0421 CYRILLIC CAPITAL LETTER ES
  ['Е', 'E'],  // U+0415 CYRILLIC CAPITAL LETTER IE
  ['М', 'M'],  // U+041C CYRILLIC CAPITAL LETTER EM
  ['О', 'O'],  // U+041E CYRILLIC CAPITAL LETTER O
  ['Р', 'P'],  // U+0420 CYRILLIC CAPITAL LETTER ER
  ['Т', 'T'],  // U+0422 CYRILLIC CAPITAL LETTER TE
  ['Х', 'X'],  // U+0425 CYRILLIC CAPITAL LETTER HA
  ['І', 'I'],  // U+0406 CYRILLIC CAPITAL LETTER BYELORUSSIAN-UKRAINIAN I
  ['Ѕ', 'S'],  // U+0405 CYRILLIC CAPITAL LETTER DZE
  ['Ј', 'J'],  // U+0408 CYRILLIC CAPITAL LETTER JE
  ['Н', 'H'],  // U+041D CYRILLIC CAPITAL LETTER EN (looks like H)
  ['Ѡ', 'W'],  // U+0460 CYRILLIC CAPITAL LETTER OMEGA → W (rough lookalike)
  ['Ԁ', 'D'],  // U+0500 CYRILLIC CAPITAL LETTER KOMI DE
  ['Ԛ', 'Q'],  // U+051A CYRILLIC CAPITAL LETTER QA
  ['Ԝ', 'W'],  // U+051C CYRILLIC CAPITAL LETTER WE
  ['К', 'K'],  // U+041A CYRILLIC CAPITAL LETTER KA (looks like K)
  ['Ʌ', 'V'],  // U+0245 LATIN CAPITAL LETTER TURNED V (looks like V or U+0416-ish)

  // ── 希腊字母小写 ───────────────────────────────────────────────────────────
  // TR39 高价值:实际恶意 npm 包和 MCP 工具描述中有使用
  ['α', 'a'],  // U+03B1 GREEK SMALL LETTER ALPHA
  ['β', 'b'],  // U+03B2 GREEK SMALL LETTER BETA (rough)
  ['ε', 'e'],  // U+03B5 GREEK SMALL LETTER EPSILON
  ['η', 'n'],  // U+03B7 GREEK SMALL LETTER ETA → n (visual lookalike)
  ['ι', 'i'],  // U+03B9 GREEK SMALL LETTER IOTA
  ['κ', 'k'],  // U+03BA GREEK SMALL LETTER KAPPA
  ['ο', 'o'],  // U+03BF GREEK SMALL LETTER OMICRON — 与拉丁 o 完全同形
  ['ρ', 'p'],  // U+03C1 GREEK SMALL LETTER RHO → p
  ['τ', 't'],  // U+03C4 GREEK SMALL LETTER TAU
  ['χ', 'x'],  // U+03C7 GREEK SMALL LETTER CHI → x

  // ── 希腊字母大写 ───────────────────────────────────────────────────────────
  ['Α', 'A'],  // U+0391 GREEK CAPITAL LETTER ALPHA
  ['Β', 'B'],  // U+0392 GREEK CAPITAL LETTER BETA
  ['Ε', 'E'],  // U+0395 GREEK CAPITAL LETTER EPSILON
  ['Ζ', 'Z'],  // U+0396 GREEK CAPITAL LETTER ZETA
  ['Η', 'H'],  // U+0397 GREEK CAPITAL LETTER ETA
  ['Ι', 'I'],  // U+0399 GREEK CAPITAL LETTER IOTA
  ['Κ', 'K'],  // U+039A GREEK CAPITAL LETTER KAPPA
  ['Μ', 'M'],  // U+039C GREEK CAPITAL LETTER MU
  ['Ν', 'N'],  // U+039D GREEK CAPITAL LETTER NU
  ['Ο', 'O'],  // U+039F GREEK CAPITAL LETTER OMICRON
  ['Ρ', 'P'],  // U+03A1 GREEK CAPITAL LETTER RHO
  ['Τ', 'T'],  // U+03A4 GREEK CAPITAL LETTER TAU
  ['Υ', 'Y'],  // U+03A5 GREEK CAPITAL LETTER UPSILON
  ['Χ', 'X'],  // U+03A7 GREEK CAPITAL LETTER CHI

  // ── 全角 ASCII(NFKC 已处理大部分,但补充常见遗漏) ──────────────────────────
  // 注:NFKC 归一化会将全角字符映射到半角,以下为 NFKC 之后仍可能遗漏的
  // (实际上 NFKC 已处理所有 U+FF01–U+FF5E,此处作为安全网)
  ['ａ', 'a'],  // U+FF41 FULLWIDTH LATIN SMALL LETTER A
  ['ｂ', 'b'],  // U+FF42 FULLWIDTH LATIN SMALL LETTER B
  ['ｃ', 'c'],  // U+FF43 FULLWIDTH LATIN SMALL LETTER C
  ['ｄ', 'd'],  // U+FF44 FULLWIDTH LATIN SMALL LETTER D
  ['ｅ', 'e'],  // U+FF45 FULLWIDTH LATIN SMALL LETTER E
  ['ｆ', 'f'],  // U+FF46 FULLWIDTH LATIN SMALL LETTER F
  ['ｇ', 'g'],  // U+FF47 FULLWIDTH LATIN SMALL LETTER G
  ['ｈ', 'h'],  // U+FF48 FULLWIDTH LATIN SMALL LETTER H
  ['ｉ', 'i'],  // U+FF49 FULLWIDTH LATIN SMALL LETTER I
  ['ｊ', 'j'],  // U+FF4A FULLWIDTH LATIN SMALL LETTER J
  ['ｋ', 'k'],  // U+FF4B FULLWIDTH LATIN SMALL LETTER K
  ['ｌ', 'l'],  // U+FF4C FULLWIDTH LATIN SMALL LETTER L
  ['ｍ', 'm'],  // U+FF4D FULLWIDTH LATIN SMALL LETTER M
  ['ｎ', 'n'],  // U+FF4E FULLWIDTH LATIN SMALL LETTER N
  ['ｏ', 'o'],  // U+FF4F FULLWIDTH LATIN SMALL LETTER O
  ['ｐ', 'p'],  // U+FF50 FULLWIDTH LATIN SMALL LETTER P
  ['ｑ', 'q'],  // U+FF51 FULLWIDTH LATIN SMALL LETTER Q
  ['ｒ', 'r'],  // U+FF52 FULLWIDTH LATIN SMALL LETTER R
  ['ｓ', 's'],  // U+FF53 FULLWIDTH LATIN SMALL LETTER S
  ['ｔ', 't'],  // U+FF54 FULLWIDTH LATIN SMALL LETTER T
  ['ｕ', 'u'],  // U+FF55 FULLWIDTH LATIN SMALL LETTER U
  ['ｖ', 'v'],  // U+FF56 FULLWIDTH LATIN SMALL LETTER V
  ['ｗ', 'w'],  // U+FF57 FULLWIDTH LATIN SMALL LETTER W
  ['ｘ', 'x'],  // U+FF58 FULLWIDTH LATIN SMALL LETTER X
  ['ｙ', 'y'],  // U+FF59 FULLWIDTH LATIN SMALL LETTER Y
  ['ｚ', 'z'],  // U+FF5A FULLWIDTH LATIN SMALL LETTER Z
  ['Ａ', 'A'],  // U+FF21 FULLWIDTH LATIN CAPITAL LETTER A
  ['Ｂ', 'B'],  // U+FF22
  ['Ｃ', 'C'],  // U+FF23
  ['Ｄ', 'D'],  // U+FF24
  ['Ｅ', 'E'],  // U+FF25
  ['Ｆ', 'F'],  // U+FF26
  ['Ｇ', 'G'],  // U+FF27
  ['Ｈ', 'H'],  // U+FF28
  ['Ｉ', 'I'],  // U+FF29
  ['Ｊ', 'J'],  // U+FF2A
  ['Ｋ', 'K'],  // U+FF2B
  ['Ｌ', 'L'],  // U+FF2C
  ['Ｍ', 'M'],  // U+FF2D
  ['Ｎ', 'N'],  // U+FF2E
  ['Ｏ', 'O'],  // U+FF2F
  ['Ｐ', 'P'],  // U+FF30
  ['Ｑ', 'Q'],  // U+FF31
  ['Ｒ', 'R'],  // U+FF32
  ['Ｓ', 'S'],  // U+FF33
  ['Ｔ', 'T'],  // U+FF34
  ['Ｕ', 'U'],  // U+FF35
  ['Ｖ', 'V'],  // U+FF36
  ['Ｗ', 'W'],  // U+FF37
  ['Ｘ', 'X'],  // U+FF38
  ['Ｙ', 'Y'],  // U+FF39
  ['Ｚ', 'Z'],  // U+FF3A

  // ── Latin lookalike(非 Cyrillic / 非希腊,常见于 IPA 扩展或装饰字体) ──────
  ['ɑ', 'a'],  // U+0251 LATIN SMALL LETTER ALPHA
  ['ɐ', 'a'],  // U+0250 LATIN SMALL LETTER TURNED A
  ['ᴀ', 'A'],  // U+1D00 LATIN LETTER SMALL CAPITAL A
  ['ɓ', 'b'],  // U+0253 LATIN SMALL LETTER B WITH HOOK
  ['ƅ', 'b'],  // U+0185 LATIN SMALL LETTER TONE SIX (rough)
  ['ᴄ', 'C'],  // U+1D04 LATIN LETTER SMALL CAPITAL C
  ['ɔ', 'c'],  // U+0254 LATIN SMALL LETTER OPEN O → c (common TR39)
  ['ᴅ', 'D'],  // U+1D05 LATIN LETTER SMALL CAPITAL D
  ['ᴇ', 'E'],  // U+1D07 LATIN LETTER SMALL CAPITAL E
  ['ғ', 'f'],  // U+0493 CYRILLIC SMALL LETTER GHE WITH STROKE (used as f)
  ['ɡ', 'g'],  // U+0261 LATIN SMALL LETTER SCRIPT G
  ['ɢ', 'G'],  // U+0262 LATIN LETTER SMALL CAPITAL G
  ['ʜ', 'H'],  // U+029C LATIN LETTER SMALL CAPITAL H
  ['ɦ', 'h'],  // U+0266 LATIN SMALL LETTER H WITH HOOK
  ['ı', 'i'],  // U+0131 LATIN SMALL LETTER DOTLESS I
  ['ɩ', 'i'],  // U+0269 LATIN SMALL LETTER IOTA
  ['ɪ', 'I'],  // U+026A LATIN LETTER SMALL CAPITAL I
  ['ᴊ', 'J'],  // U+1D0A LATIN LETTER SMALL CAPITAL J
  ['ᴋ', 'K'],  // U+1D0B LATIN LETTER SMALL CAPITAL K
  ['ʟ', 'L'],  // U+029F LATIN LETTER SMALL CAPITAL L
  ['ʼ', '\''], // U+02BC MODIFIER LETTER APOSTROPHE → apostrophe
  ['ℓ', 'l'],  // U+2113 SCRIPT SMALL L
  ['ɱ', 'm'],  // U+0271 LATIN SMALL LETTER M WITH HOOK
  ['ᴍ', 'M'],  // U+1D0D LATIN LETTER SMALL CAPITAL M
  ['ɴ', 'N'],  // U+0274 LATIN LETTER SMALL CAPITAL N
  ['ᴏ', 'O'],  // U+1D0F LATIN LETTER SMALL CAPITAL O
  ['ᴘ', 'P'],  // U+1D18 LATIN LETTER SMALL CAPITAL P
  ['ʀ', 'R'],  // U+0280 LATIN LETTER SMALL CAPITAL R
  ['ʁ', 'R'],  // U+0281 LATIN LETTER SMALL CAPITAL INVERTED R
  ['ѕ', 's'],  // (already in Cyrillic above but kept as safety net)
  ['ꜱ', 'S'],  // U+A731 LATIN LETTER SMALL CAPITAL S
  ['ᴛ', 'T'],  // U+1D1B LATIN LETTER SMALL CAPITAL T
  ['ᴜ', 'U'],  // U+1D1C LATIN LETTER SMALL CAPITAL U
  ['ᴠ', 'V'],  // U+1D20 LATIN LETTER SMALL CAPITAL V
  ['ᴡ', 'W'],  // U+1D21 LATIN LETTER SMALL CAPITAL W
  ['ʏ', 'Y'],  // U+028F LATIN LETTER SMALL CAPITAL Y
  ['ᴢ', 'Z'],  // U+1D22 LATIN LETTER SMALL CAPITAL Z

  // ── 数字同形字 ──────────────────────────────────────────────────────────────
  // 用于混淆版本号、端口号等
  ['０', '0'],  // U+FF10 FULLWIDTH DIGIT ZERO
  ['１', '1'],  // U+FF11 FULLWIDTH DIGIT ONE
  ['２', '2'],  // U+FF12
  ['３', '3'],  // U+FF13
  ['４', '4'],  // U+FF14
  ['５', '5'],  // U+FF15
  ['６', '6'],  // U+FF16
  ['７', '7'],  // U+FF17
  ['８', '8'],  // U+FF18
  ['９', '9'],  // U+FF19
]);
