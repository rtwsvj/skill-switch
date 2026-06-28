// P3-D4 供应链漂移:OSV 扫描单元测试。
//
// 覆盖范围:
//   1. parseSkillDependencies — package.json / requirements.txt / Cargo.toml 解析
//   2. queryOsvBatch — 假 fetch 注入,验证 querybatch 请求格式与结果解析
//   3. 默认不联网:不传 fetchFn 时 queryOsvBatch 直接抛出(不隐式使用全局 fetch)
//   4. 超时兜底:scanSkillOsv 对超时/网络失败的降级处理
//   5. formatOsvResults — 输出格式
//
// 所有测试均在 mkdtempSync 隔离目录下;不发起真实网络请求。

import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatOsvResults,
  parseSkillDependencies,
  queryOsvBatch,
  scanSkillOsv,
} from '../src/core/osv.ts';
import type { FetchFn, OsvPackageQuery } from '../src/core/osv.ts';

// ─── 辅助 ─────────────────────────────────────────────────────────────────────

let skillDir: string;

beforeEach(() => {
  skillDir = mkdtempSync(join(tmpdir(), 'osv-test-'));
});

/** 构造一个成功返回指定漏洞列表的假 fetch */
function makeFakeFetch(vulnsByIndex: Array<Array<{ id: string; summary?: string }>>): FetchFn {
  return async (_url: string, _init?: RequestInit) => {
    const body = JSON.stringify({
      results: vulnsByIndex.map((vulns) => (vulns.length > 0 ? { vulns } : {})),
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

/** 构造总是抛出网络错误的假 fetch */
function makeFailingFetch(message = '网络不可达'): FetchFn {
  return async (_url: string, _init?: RequestInit) => {
    throw new Error(message);
  };
}

// ─── parseSkillDependencies ────────────────────────────────────────────────────

describe('parseSkillDependencies', () => {
  it('空目录 → 返回空列表', async () => {
    const pkgs = await parseSkillDependencies(skillDir);
    expect(pkgs).toEqual([]);
  });

  it('解析 package.json dependencies(忽略 devDependencies)', async () => {
    await writeFile(
      join(skillDir, 'package.json'),
      JSON.stringify({
        dependencies: { lodash: '^4.17.21', axios: '1.6.0' },
        devDependencies: { vitest: '^1.0.0' },
      }),
    );
    const pkgs = await parseSkillDependencies(skillDir);
    expect(pkgs).toHaveLength(2);
    const lodash = pkgs.find((p) => p.name === 'lodash');
    expect(lodash).toBeDefined();
    expect(lodash!.ecosystem).toBe('npm');
    // ^ 符号被剥离
    expect(lodash!.version).toBe('4.17.21');
    // devDependencies 不在结果里
    expect(pkgs.find((p) => p.name === 'vitest')).toBeUndefined();
  });

  it('解析 requirements.txt(== 精确版本)', async () => {
    await writeFile(
      join(skillDir, 'requirements.txt'),
      'requests==2.31.0\nnumpy==1.24.0\n# 注释行\n\n',
    );
    const pkgs = await parseSkillDependencies(skillDir);
    expect(pkgs).toHaveLength(2);
    expect(pkgs.find((p) => p.name === 'requests')?.version).toBe('2.31.0');
    expect(pkgs.find((p) => p.name === 'numpy')?.version).toBe('1.24.0');
    expect(pkgs.every((p) => p.ecosystem === 'PyPI')).toBe(true);
  });

  it('解析 requirements.txt(>=宽松版本作为近似)', async () => {
    await writeFile(join(skillDir, 'requirements.txt'), 'flask>=2.0.0\n');
    const pkgs = await parseSkillDependencies(skillDir);
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]!.name).toBe('flask');
    expect(pkgs[0]!.version).toBe('2.0.0');
  });

  it('解析 Cargo.toml [dependencies] 节(简单字符串形式)', async () => {
    await writeFile(
      join(skillDir, 'Cargo.toml'),
      '[package]\nname = "my-skill"\n\n[dependencies]\nserde = "1.0.196"\ntokio = "1.36.0"\n',
    );
    const pkgs = await parseSkillDependencies(skillDir);
    expect(pkgs).toHaveLength(2);
    expect(pkgs.find((p) => p.name === 'serde')?.version).toBe('1.0.196');
    expect(pkgs.find((p) => p.name === 'tokio')?.version).toBe('1.36.0');
    expect(pkgs.every((p) => p.ecosystem === 'crates.io')).toBe(true);
  });

  it('Cargo.toml 中 [dev-dependencies] 不被误读入 dependencies', async () => {
    await writeFile(
      join(skillDir, 'Cargo.toml'),
      '[dependencies]\nserde = "1.0"\n\n[dev-dependencies]\ncriterion = "0.5"\n',
    );
    const pkgs = await parseSkillDependencies(skillDir);
    // criterion 属于 dev-dependencies,不应出现
    expect(pkgs.find((p) => p.name === 'criterion')).toBeUndefined();
    expect(pkgs.find((p) => p.name === 'serde')).toBeDefined();
  });

  it('多种文件并存时合并结果', async () => {
    await writeFile(join(skillDir, 'package.json'), JSON.stringify({ dependencies: { axios: '1.0.0' } }));
    await writeFile(join(skillDir, 'requirements.txt'), 'requests==2.0.0\n');
    const pkgs = await parseSkillDependencies(skillDir);
    expect(pkgs).toHaveLength(2);
    expect(pkgs.map((p) => p.ecosystem).sort()).toEqual(['PyPI', 'npm']);
  });
});

// ─── queryOsvBatch ─────────────────────────────────────────────────────────────

describe('queryOsvBatch', () => {
  const packages: OsvPackageQuery[] = [
    { name: 'lodash', version: '4.17.4', ecosystem: 'npm' },
    { name: 'requests', version: '2.19.0', ecosystem: 'PyPI' },
  ];

  it('空列表 → 不调用 fetch,返回空结果', async () => {
    const spy = vi.fn();
    const result = await queryOsvBatch([], spy as unknown as FetchFn);
    expect(result).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('向 OSV_QUERYBATCH_URL 发起 POST,请求体包含所有包', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    const fakeFetch: FetchFn = async (url, init) => {
      capturedUrl = url;
      capturedBody = (init?.body as string) ?? '';
      return new Response(JSON.stringify({ results: [{}, {}] }), { status: 200 });
    };

    await queryOsvBatch(packages, fakeFetch);
    expect(capturedUrl).toBe('https://api.osv.dev/v1/querybatch');
    const parsed = JSON.parse(capturedBody) as {
      queries: Array<{ version: string; package: { name: string; ecosystem: string } }>;
    };
    expect(parsed.queries).toHaveLength(2);
    expect(parsed.queries[0]!.package.name).toBe('lodash');
    expect(parsed.queries[1]!.package.name).toBe('requests');
  });

  it('API 返回漏洞时正确映射到对应包', async () => {
    const fakeFetch = makeFakeFetch([
      [{ id: 'GHSA-aaa-bbb-ccc', summary: 'Prototype pollution' }],
      [], // requests 无漏洞
    ]);
    const results = await queryOsvBatch(packages, fakeFetch);
    expect(results).toHaveLength(2);
    expect(results[0]!.pkg.name).toBe('lodash');
    expect(results[0]!.vulns).toHaveLength(1);
    expect(results[0]!.vulns[0]!.id).toBe('GHSA-aaa-bbb-ccc');
    expect(results[0]!.vulns[0]!.summary).toBe('Prototype pollution');
    expect(results[1]!.pkg.name).toBe('requests');
    expect(results[1]!.vulns).toHaveLength(0);
  });

  it('API 返回空 results 数组时优雅处理(不崩溃)', async () => {
    const fakeFetch: FetchFn = async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 });
    const results = await queryOsvBatch(packages, fakeFetch);
    expect(results).toHaveLength(2);
    expect(results[0]!.vulns).toHaveLength(0);
  });

  it('API 返回非 200 时抛出(调用方捕获)', async () => {
    const fakeFetch: FetchFn = async () => new Response('Internal Server Error', { status: 500 });
    await expect(queryOsvBatch(packages, fakeFetch)).rejects.toThrow(/HTTP 500/);
  });

  it('网络失败时抛出(调用方捕获)', async () => {
    await expect(queryOsvBatch(packages, makeFailingFetch())).rejects.toThrow(/querybatch 请求失败/);
  });

  it('默认不联网:不传 fetchFn 会导致 TypeScript 类型错误(设计契约验证)', () => {
    // 运行时验证:queryOsvBatch 要求 fetchFn 必须是函数;
    // 若传 undefined 则在 JS 中调用时立即报错(设计上不允许隐式联网)。
    // 这里通过 as unknown as FetchFn 绕过类型检查来验证运行时行为。
    const undefinedFetch = undefined as unknown as FetchFn;
    // 调用 queryOsvBatch with packages 会尝试调用 undefinedFetch()
    return expect(queryOsvBatch(packages, undefinedFetch)).rejects.toThrow();
  });
});

// ─── scanSkillOsv ──────────────────────────────────────────────────────────────

describe('scanSkillOsv', () => {
  it('无依赖文件 → diagnostics 包含跳过说明,packages 为空', async () => {
    const fakeFetch = makeFakeFetch([]);
    const result = await scanSkillOsv(skillDir, fakeFetch);
    expect(result.packages).toHaveLength(0);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]).toContain('跳过');
  });

  it('有依赖文件且无 CVE → packages 有内容,vulns 为空', async () => {
    await writeFile(join(skillDir, 'package.json'), JSON.stringify({ dependencies: { axios: '1.0.0' } }));
    const fakeFetch = makeFakeFetch([[]]); // 无漏洞
    const result = await scanSkillOsv(skillDir, fakeFetch);
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]!.vulns).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
  });

  it('有依赖文件且命中 CVE → vulns 有数据', async () => {
    await writeFile(
      join(skillDir, 'package.json'),
      JSON.stringify({ dependencies: { lodash: '4.17.4' } }),
    );
    const fakeFetch = makeFakeFetch([[{ id: 'GHSA-p6mc-m468-83gw', summary: 'Prototype pollution' }]]);
    const result = await scanSkillOsv(skillDir, fakeFetch);
    expect(result.packages[0]!.vulns[0]!.id).toBe('GHSA-p6mc-m468-83gw');
  });

  it('网络失败时降级:packages 返回包列表但 vulns 为空,diagnostics 含错误信息', async () => {
    await writeFile(join(skillDir, 'package.json'), JSON.stringify({ dependencies: { axios: '1.0.0' } }));
    const result = await scanSkillOsv(skillDir, makeFailingFetch('timeout'));
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]).toContain('OSV 扫描失败');
    // 降级:包仍在列表里,但 vulns 为空
    expect(result.packages[0]!.pkg.name).toBe('axios');
    expect(result.packages[0]!.vulns).toHaveLength(0);
  });
});

// ─── formatOsvResults ──────────────────────────────────────────────────────────

describe('formatOsvResults', () => {
  it('无 CVE 命中 → 输出"无已知 CVE"行', () => {
    const lines = formatOsvResults([
      {
        skillDir: '/home/user/.claude/skills/my-skill',
        packages: [{ pkg: { name: 'axios', version: '1.0.0', ecosystem: 'npm' }, vulns: [] }],
        diagnostics: [],
      },
    ]);
    expect(lines.some((l) => l.includes('无已知 CVE'))).toBe(true);
  });

  it('命中 CVE → 输出含包名、版本、CVE ID 的行', () => {
    const lines = formatOsvResults([
      {
        skillDir: '/home/user/.claude/skills/vuln-skill',
        packages: [
          {
            pkg: { name: 'lodash', version: '4.17.4', ecosystem: 'npm' },
            vulns: [{ id: 'GHSA-aaa-bbb-ccc', summary: 'Prototype pollution' }],
          },
        ],
        diagnostics: [],
      },
    ]);
    expect(lines.some((l) => l.includes('lodash@4.17.4'))).toBe(true);
    expect(lines.some((l) => l.includes('GHSA-aaa-bbb-ccc'))).toBe(true);
  });

  it('diagnostics 有内容时打印诊断行', () => {
    const lines = formatOsvResults([
      {
        skillDir: '/tmp/skill',
        packages: [],
        diagnostics: ['OSV 扫描失败(已跳过): 网络不可达'],
      },
    ]);
    expect(lines.some((l) => l.includes('OSV'))).toBe(true);
  });

  it('空输入 → 返回空列表', () => {
    expect(formatOsvResults([])).toEqual([]);
  });
});
