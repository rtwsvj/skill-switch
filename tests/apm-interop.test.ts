// 任务 D 测试:microsoft/apm 互操作(只读)。
// 覆盖:
//   ① 解析样例 apm.yml(含若干 skill 源)→ 映射出预期声明
//   ② 含非 skill 原语 → 正确跳过并标注
//   ③ 损坏 / 非法 YAML → 稳健报错不崩(抛 InvalidApmYamlError,而非未捕获异常)
//   ④ dry-run 不写盘(临时目录断言无写入)
//   ⑤ 解析不触发任何网络 / 子进程(monkeypatch http/https/child_process,断言零调用)
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InvalidApmYamlError,
  mapApmToImports,
  parseYamlSubset,
  toSkillDeclarations,
} from '../src/core/apm-interop.ts';
import { runApmImport } from '../src/cli/commands/apm-import.ts';
import { getSkillsJsonPath, readDeclaration } from '../src/core/sync.ts';

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const SAMPLE_APM = `
# microsoft/apm 风格的声明文件
sources:
  official:
    url: https://github.com/example/skills
  local-dir:
    path: ./vendor/skills

dependencies:
  skills:
    - name: code-review
      source: official
      path: skills/code-review
      version: 1.2.0
    - name: secure-scan
      source: local-dir
    - lone-skill            # 纯标量项:只有名字
  prompts:
    - name: summarize
    - name: translate
  agents:
    - name: researcher
  hooks:
    - pre-commit
`;

const SAMPLE_LOCK = `
skills:
  code-review:
    version: 1.2.0
    integrity: sha256-abc123
    resolved: https://github.com/example/skills/code-review
  secure-scan:
    version: 0.9.1
    integrity: sha256-def456
`;

describe('apm-interop: YAML 子集解析器', () => {
  it('解析基本 map/sequence/标量/引号/注释', () => {
    const doc = parseYamlSubset(SAMPLE_APM) as Record<string, unknown>;
    expect(doc).toBeTypeOf('object');
    expect((doc.sources as Record<string, unknown>).official).toEqual({
      url: 'https://github.com/example/skills',
    });
    const deps = doc.dependencies as Record<string, unknown>;
    expect(Array.isArray(deps.skills)).toBe(true);
    expect((deps.skills as unknown[]).length).toBe(3);
  });

  it('数字 / 布尔 / null 标量按类型解析', () => {
    const doc = parseYamlSubset('a: 1\nb: true\nc: null\nd: 1.5\ne: "1"') as Record<string, unknown>;
    expect(doc.a).toBe(1);
    expect(doc.b).toBe(true);
    expect(doc.c).toBe(null);
    expect(doc.d).toBe(1.5);
    expect(doc.e).toBe('1'); // 引号保字符串
  });

  it('行尾注释与引号内的 # 不被误当注释', () => {
    const doc = parseYamlSubset('a: foo # 注释\nb: "x # y"') as Record<string, unknown>;
    expect(doc.a).toBe('foo');
    expect(doc.b).toBe('x # y');
  });
});

describe('apm-interop: 映射(mapApmToImports)', () => {
  it('① 解析含若干 skill 源的 apm.yml → 映射出预期声明', () => {
    const apmDoc = parseYamlSubset(SAMPLE_APM);
    const lockDoc = parseYamlSubset(SAMPLE_LOCK);
    const mapping = mapApmToImports(apmDoc, lockDoc);

    const names = mapping.skills.map((s) => s.name).sort();
    expect(names).toEqual(['code-review', 'lone-skill', 'secure-scan']);

    const cr = mapping.skills.find((s) => s.name === 'code-review')!;
    expect(cr.sourceRef).toBe('official');
    expect(cr.source).toBe('https://github.com/example/skills'); // 命名源被解析成 url(provenance)
    expect(cr.path).toBe('skills/code-review');
    expect(cr.version).toBe('1.2.0');
    expect(cr.integrity).toBe('sha256-abc123'); // 来自锁文件

    const ss = mapping.skills.find((s) => s.name === 'secure-scan')!;
    expect(ss.source).toBe('./vendor/skills');
    expect(ss.version).toBe('0.9.1'); // 声明无 version,从锁补全
    expect(ss.integrity).toBe('sha256-def456');

    // 映射到 skill-switch 声明:默认 enabled=false(纳管但不启用)
    const decls = toSkillDeclarations(mapping.skills);
    expect(decls.every((d) => d.enabled === false)).toBe(true);
    expect(decls.every((d) => d.agents.includes('claude-code'))).toBe(true);
    const crDecl = decls.find((d) => d.name === 'code-review')!;
    expect(crDecl.source).toBe('skills/code-review'); // 优先 path 作为本地内容目录占位
  });

  it('② 含非 skill 原语 → 正确跳过并标注', () => {
    const mapping = mapApmToImports(parseYamlSubset(SAMPLE_APM));
    const categories = mapping.skipped.map((s) => s.category).sort();
    expect(categories).toEqual(['agents', 'hooks', 'prompts']);

    const prompts = mapping.skipped.find((s) => s.category === 'prompts')!;
    expect(prompts.count).toBe(2);
    expect(prompts.reason).toContain('非 skill 原语');

    // skill 类没被错误跳过
    expect(mapping.skipped.some((s) => s.category === 'skills')).toBe(false);
  });

  it('未知原语类别也保守跳过', () => {
    const doc = parseYamlSubset('dependencies:\n  weird-thing:\n    - a\n    - b');
    const mapping = mapApmToImports(doc);
    expect(mapping.skills).toHaveLength(0);
    const sk = mapping.skipped.find((s) => s.category === 'weird-thing')!;
    expect(sk).toBeDefined();
    expect(sk.reason).toContain('未知原语类别');
    expect(sk.count).toBe(2);
  });

  it('不安全的 skill 名被丢弃并写 warning(安全护栏)', () => {
    const doc = parseYamlSubset('dependencies:\n  skills:\n    - name: "../evil"\n    - name: good');
    const mapping = mapApmToImports(doc);
    expect(mapping.skills.map((s) => s.name)).toEqual(['good']);
    expect(mapping.warnings.some((w) => w.includes('安全护栏'))).toBe(true);
  });

  it('skills 也支持 map 形态 { name: {...} }', () => {
    const doc = parseYamlSubset('primitives:\n  skills:\n    alpha:\n      version: 2.0.0');
    const mapping = mapApmToImports(doc);
    expect(mapping.skills).toHaveLength(1);
    expect(mapping.skills[0]!.name).toBe('alpha');
    expect(mapping.skills[0]!.version).toBe('2.0.0');
  });

  it('顶层非 map 的文档被稳健拒绝', () => {
    expect(() => mapApmToImports(parseYamlSubset('- a\n- b'))).toThrow(InvalidApmYamlError);
  });
});

describe('apm-interop: ③ 损坏 / 非法 YAML 稳健报错', () => {
  const bad: Array<[string, string]> = [
    ['制表符缩进', 'a:\n\tb: 1'],
    ['奇数缩进', 'a:\n   b: 1'],
    ['流式集合', 'a: [1, 2, 3]'],
    ['锚点', 'a: &anchor 1'],
    ['未闭合双引号', 'a: "unterminated'],
    ['顶层有缩进', '  a: 1'],
    ['非 key:value 行', 'just-some-text-no-colon-here'],
  ];
  for (const [label, src] of bad) {
    it(`${label} → 抛 InvalidApmYamlError 而非崩溃`, () => {
      expect(() => parseYamlSubset(src)).toThrow(InvalidApmYamlError);
    });
  }

  it('空文档解析为 null,映射时稳健拒绝(不崩)', () => {
    expect(parseYamlSubset('')).toBe(null);
    expect(parseYamlSubset('# 只有注释\n')).toBe(null);
    expect(() => mapApmToImports(null)).toThrow(InvalidApmYamlError);
  });
});

describe('apm-interop: ④ dry-run 不写盘', () => {
  it('默认 dry-run:解析 + 报告,但临时 home 下无任何写入', async () => {
    const home = tmpDir('ss-apm-home-');
    const work = tmpDir('ss-apm-work-');
    const apmPath = join(work, 'apm.yml');
    await writeFile(apmPath, SAMPLE_APM, 'utf8');
    await writeFile(join(work, 'apm.lock.yaml'), SAMPLE_LOCK, 'utf8');

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => {
      logs.push(a.join(' '));
    });

    const mapping = await runApmImport(apmPath, { home });
    logSpy.mockRestore();

    // 没写声明文件
    expect(existsSync(getSkillsJsonPath(home))).toBe(false);
    // home 下 .skill-switch 目录都不该被创建(没有任何写盘副作用)
    expect(existsSync(join(home, '.skill-switch'))).toBe(false);
    // 但确实解析出了 skill,并打印了 dry-run 提示
    expect(mapping.skills).toHaveLength(3);
    expect(logs.join('\n')).toContain('[dry-run]');
  });

  it('--apply:写入声明(默认未启用),复用现有声明写入逻辑', async () => {
    const home = tmpDir('ss-apm-home2-');
    const work = tmpDir('ss-apm-work2-');
    const apmPath = join(work, 'apm.yml');
    await writeFile(apmPath, SAMPLE_APM, 'utf8');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runApmImport(apmPath, { home, apply: true });

    const declPath = getSkillsJsonPath(home);
    expect(existsSync(declPath)).toBe(true);
    const decl = await readDeclaration(declPath);
    const names = decl.skills.map((s) => s.name).sort();
    expect(names).toEqual(['code-review', 'lone-skill', 'secure-scan']);
    // 写入的声明结构合法、带 agents
    expect(decl.skills.every((s) => s.agents.includes('claude-code'))).toBe(true);
  });

  it('找不到 apm.yml → 明确报错,不写盘', async () => {
    const home = tmpDir('ss-apm-home3-');
    await expect(runApmImport(join(home, 'nope.yml'), { home })).rejects.toThrow(/找不到 apm.yml/);
    expect(existsSync(getSkillsJsonPath(home))).toBe(false);
  });

  it('损坏的 apm.yml → 报错且不写盘', async () => {
    const home = tmpDir('ss-apm-home4-');
    const work = tmpDir('ss-apm-work4-');
    const apmPath = join(work, 'apm.yml');
    await writeFile(apmPath, 'a:\n\tb: 1', 'utf8'); // 制表符缩进
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runApmImport(apmPath, { home })).rejects.toThrow(/解析失败/);
    expect(existsSync(getSkillsJsonPath(home))).toBe(false);
  });
});

describe('apm-interop: ⑤ 不触发任何网络 / 子进程', () => {
  // ESM 下无法 spy 模块命名空间导出(dns.lookup / cp.spawn 等),
  // 故运行时哨兵挂在 **可配置的原型方法 / 可写全局** 上:
  //   - 所有 TCP 出站都经过 net.Socket.prototype.connect(原型方法,可 spy)
  //   - 顶层 fetch(可写全局)
  // 子进程 / DNS 层面无法在 ESM 里安全 spy,改由下方的"静态 import 检查"覆盖。
  it('解析 + 映射 + dry-run 全程零 TCP 连接 / 零 fetch', async () => {
    const net = await import('node:net');
    const calls: string[] = [];
    const guard =
      (label: string) =>
      (): never => {
        calls.push(label);
        throw new Error(`apm-interop 不应调用 ${label}`);
      };

    const socketConnect = vi
      .spyOn(net.Socket.prototype, 'connect')
      .mockImplementation(guard('net.Socket.connect') as never);

    let fetchOriginal: typeof globalThis.fetch | undefined;
    if (typeof globalThis.fetch === 'function') {
      fetchOriginal = globalThis.fetch;
      globalThis.fetch = guard('fetch') as never;
    }

    const home = tmpDir('ss-apm-net-');
    const work = tmpDir('ss-apm-network-');
    const apmPath = join(work, 'apm.yml');
    await writeFile(apmPath, SAMPLE_APM, 'utf8');
    await writeFile(join(work, 'apm.lock.yaml'), SAMPLE_LOCK, 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      // 纯解析路径
      mapApmToImports(parseYamlSubset(SAMPLE_APM), parseYamlSubset(SAMPLE_LOCK));
      // 命令路径(dry-run)
      await runApmImport(apmPath, { home });
    } finally {
      socketConnect.mockRestore();
      if (fetchOriginal) globalThis.fetch = fetchOriginal;
    }

    expect(calls).toEqual([]);
    // 同时再次确认 dry-run 没写盘
    expect(existsSync(getSkillsJsonPath(home))).toBe(false);
    // 临时 work 目录里也没多出任何文件(只剩我们放进去的两个)
    expect(readdirSync(work).sort()).toEqual(['apm.lock.yaml', 'apm.yml']);
  });

  it('apm-interop 源码静态上不 import node:http(s) / node:net / child_process', async () => {
    const core = await readFile(join(import.meta.dirname, '..', 'src', 'core', 'apm-interop.ts'), 'utf8');
    const cmd = await readFile(
      join(import.meta.dirname, '..', 'src', 'cli', 'commands', 'apm-import.ts'),
      'utf8',
    );
    for (const src of [core, cmd]) {
      expect(src).not.toMatch(/from ['"]node:(http|https|net|dns|child_process)['"]/);
      expect(src).not.toMatch(/require\(['"]node:(http|https|net|child_process)['"]\)/);
    }
  });
});

// 防御:确认 apm.lock.yaml 是从 apm.yml 同目录被读到的(不需要显式 --lock)
describe('apm-interop: 锁文件自动探测', () => {
  it('同目录的 apm.lock.yaml 被自动读取,integrity 进入映射', async () => {
    const home = tmpDir('ss-apm-lock-');
    const work = tmpDir('ss-apm-lockwork-');
    await writeFile(join(work, 'apm.yml'), SAMPLE_APM, 'utf8');
    await writeFile(join(work, 'apm.lock.yaml'), SAMPLE_LOCK, 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const mapping = await runApmImport(join(work, 'apm.yml'), { home });
    const cr = mapping.skills.find((s) => s.name === 'code-review')!;
    expect(cr.integrity).toBe('sha256-abc123');
    // 顺带确认读出来的内容没被改写到磁盘
    const onDisk = await readFile(join(work, 'apm.yml'), 'utf8');
    expect(onDisk).toBe(SAMPLE_APM);
  });
});
