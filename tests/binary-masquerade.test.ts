// 二进制魔数伪装检测验收测试,覆盖 2 条规则:
//   masquerade/binary-magic-bytes  — 文件起始命中已知可执行/归档魔数(精确前缀)
//   masquerade/binary-lossy-head   — 文件以多个连续 U+FFFD 开头(utf8 有损二进制头启发式)
//
// 关键约束模拟:config-discovery 以 'utf8' 读文件,所以这里把每种魔数的原始字节用
// Buffer.toString('utf8') 还原成 content 字符串,精确复现引擎拿到的内容形态。
//
// 测试矩阵:
//   ① 每种魔数 → 命中且 severity 合理(critical/high)
//   ② 纯文本 / 正常 markdown / json → 不命中
//   ③ 正文中间提及魔数名(如 "the MZ header")→ 不命中(因不在起始)
//   ④ 空文件 / 极短文件 → 不命中不崩溃
import { describe, expect, it } from 'vitest';
import { binaryMasqueradeRules } from '../rules/binary-masquerade.ts';
import { runFileRules } from '../src/core/audit/engine.ts';

const RULE_MAGIC = 'masquerade/binary-magic-bytes';
const RULE_LOSSY = 'masquerade/binary-lossy-head';

// ── 辅助 ─────────────────────────────────────────────────────────────────────

/** 把原始字节数组经 utf8 解码成 content 字符串(复现 config-discovery readFile('utf8') 行为) */
function bytesToContent(bytes: number[]): string {
  return Buffer.from(bytes).toString('utf8');
}

function evalRule(content: string) {
  return runFileRules(binaryMasqueradeRules, [{ file: 'SKILL.md', content }]);
}

function ruleIds(content: string): string[] {
  return evalRule(content).map((f) => f.ruleId);
}

// 已知魔数的原始字节(自写,依据公开文件格式规范)
const MAGICS: Record<string, number[]> = {
  'PE/DOS (MZ)': [0x4d, 0x5a, 0x90, 0x00, 0x03],
  'ELF': [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01],
  'PDF (%PDF)': [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37],
  'ZIP/JAR/Office (PK\\x03\\x04)': [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00],
  'ZIP EOCD (PK\\x05\\x06)': [0x50, 0x4b, 0x05, 0x06, 0x00, 0x00],
  'ZIP spanned (PK\\x07\\x08)': [0x50, 0x4b, 0x07, 0x08, 0x00, 0x00],
  'RAR (Rar!)': [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00],
  'gzip (0x1F8B)': [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00],
  '7z (0x377ABCAF271C)': [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
  'Wasm (0x0061736D)': [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
};

// 经 utf8 后坍缩为 U+FFFD 起始的二进制魔数(走有损启发式)
const LOSSY_MAGICS: Record<string, number[]> = {
  'Mach-O 32 LE (0xCEFAEDFE)': [0xce, 0xfa, 0xed, 0xfe, 0x07, 0x00],
  'Mach-O 64 (0xFEEDFACF)': [0xfe, 0xed, 0xfa, 0xcf, 0x0c, 0x00],
  'Mach-O (0xFEEDFACE)': [0xfe, 0xed, 0xfa, 0xce, 0x07, 0x00],
  'Mach-O fat / Java class (0xCAFEBABE)': [0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00],
  'Mach-O fat BE (0xBEBAFECA)': [0xbe, 0xba, 0xfe, 0xca, 0x00, 0x00],
};

// ── ① 精确魔数 — 必须命中(critical) ─────────────────────────────────────────

describe('masquerade/binary-magic-bytes — 已知魔数命中', () => {
  for (const [name, bytes] of Object.entries(MAGICS)) {
    it(`detects ${name}`, () => {
      const content = bytesToContent(bytes);
      const findings = evalRule(content);
      const ids = findings.map((f) => f.ruleId);
      expect(ids, `${name} should hit binary-magic-bytes`).toContain(RULE_MAGIC);
      const f = findings.find((x) => x.ruleId === RULE_MAGIC)!;
      expect(f.severity).toBe('critical');
      expect(f.line).toBe(1);
      expect(f.file).toBe('SKILL.md');
      // 精确魔数命中时不应同时报有损启发式(去重)
      expect(ids).not.toContain(RULE_LOSSY);
    });
  }

  it('detects MZ even when followed by a Windows .exe DOS stub text', () => {
    // 真实 PE 头后常跟 "This program cannot be run in DOS mode"
    const content = `${bytesToContent([0x4d, 0x5a, 0x90, 0x00])}This program cannot be run in DOS mode.`;
    expect(ruleIds(content)).toContain(RULE_MAGIC);
  });
});

// ── ① 有损二进制头 — 必须命中(high) ─────────────────────────────────────────

describe('masquerade/binary-lossy-head — utf8 坍缩为 U+FFFD 的魔数命中', () => {
  for (const [name, bytes] of Object.entries(LOSSY_MAGICS)) {
    it(`detects ${name} via lossy heuristic`, () => {
      const content = bytesToContent(bytes);
      const findings = evalRule(content);
      const ids = findings.map((f) => f.ruleId);
      expect(ids, `${name} should hit binary-lossy-head`).toContain(RULE_LOSSY);
      const f = findings.find((x) => x.ruleId === RULE_LOSSY)!;
      expect(f.severity).toBe('high');
      expect(f.line).toBe(1);
    });
  }
});

// ── ② 良性文本 — 零误报 ──────────────────────────────────────────────────────

describe('良性文本零误报', () => {
  const benign: Record<string, string> = {
    '纯文本': 'Hello, this is a perfectly normal skill description.\n',
    '正常 markdown': '# My Skill\n\nThis skill helps you do things.\n\n- step one\n- step two\n',
    'YAML frontmatter skill': '---\nname: helper\ndescription: A safe helper skill\n---\n\nDo good things.\n',
    'JSON 配置': '{\n  "name": "helper",\n  "version": "1.0.0",\n  "permissions": []\n}\n',
    '中文散文': '这是一个普通的技能说明文档,完全没有问题。\n',
    'emoji 内容': 'Great work 🎉🚀 keep going 👍\n',
    '以 # 开头的脚本注释': '#!/usr/bin/env bash\necho hello\n',
  };
  for (const [name, content] of Object.entries(benign)) {
    it(`${name} → 不命中`, () => {
      expect(evalRule(content)).toHaveLength(0);
    });
  }
});

// ── ③ 正文中间提及魔数名 — 不命中(只看起始) ────────────────────────────────

describe('正文提及魔数名不误报(只看文件起始)', () => {
  const mentions: Record<string, string> = {
    '提及 MZ header': 'When analyzing PE files, the MZ header at offset 0 identifies a DOS executable.\n',
    '提及 PK zip': 'A ZIP archive begins with the bytes PK\\x03\\x04 (local file header).\n',
    '提及 %PDF': 'Every PDF document starts with a %PDF-1.x signature line.\n',
    '提及 ELF': 'On Linux, an ELF binary is identified by the magic 0x7F 45 4C 46.\n',
    '提及 Rar!': 'RAR archives use the Rar! signature followed by 0x1A 0x07.\n',
    '提及 7z': 'The 7z format magic is 37 7A BC AF 27 1C.\n',
    'MZ 不在行首(前有缩进)': '    MZ is the PE magic — but here it is indented, not at file start.\n',
    'PK 出现在第二行': 'See the format docs below:\nPK is the prefix used by zip.\n',
  };
  for (const [name, content] of Object.entries(mentions)) {
    it(`${name} → 不命中`, () => {
      expect(evalRule(content)).toHaveLength(0);
    });
  }
});

// ── ④ 空 / 极短文件 — 不命中不崩溃 ───────────────────────────────────────────

describe('边界:空 / 极短文件', () => {
  it('空文件 → 不命中不崩溃', () => {
    expect(() => evalRule('')).not.toThrow();
    expect(evalRule('')).toHaveLength(0);
  });

  it('单字符 "M" → 不命中(MZ 需要两字符)', () => {
    expect(evalRule('M')).toHaveLength(0);
  });

  it('单字符 "P" → 不命中(PK 需要两字符)', () => {
    expect(evalRule('P')).toHaveLength(0);
  });

  it('单个 U+FFFD → 不命中(有损启发式需 >=3 连续)', () => {
    expect(evalRule('�')).toHaveLength(0);
  });

  it('两个 U+FFFD → 不命中(低于阈值)', () => {
    expect(evalRule('��')).toHaveLength(0);
  });

  it('三个 U+FFFD → 命中有损启发式', () => {
    expect(ruleIds('���')).toContain(RULE_LOSSY);
  });

  it('单字节非法序列(损坏文本)→ 不达 3 连续 U+FFFD 阈值,不误报', () => {
    // 0xC3 是一个孤立的 UTF-8 起始字节,解码为单个 U+FFFD;后跟普通文本
    const content = bytesToContent([0xc3, 0x68, 0x69]); // 一个 U+FFFD + "hi"
    expect(evalRule(content)).toHaveLength(0);
  });
});

// ── 规则元数据自检 ───────────────────────────────────────────────────────────

describe('规则元数据', () => {
  it('source 注明自写 + 公开格式规范', () => {
    for (const r of binaryMasqueradeRules) {
      expect(r.source).toContain('自写');
      expect(r.source).toContain('公开格式规范');
    }
  });

  it('rule id 采用 masquerade/ 类目前缀', () => {
    for (const r of binaryMasqueradeRules) {
      expect(r.id.startsWith('masquerade/')).toBe(true);
    }
  });
});
