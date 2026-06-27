// Step3 套餐模型单元测试。
// 覆盖:
//   1. validatePackManifest — 接受合法清单;拒绝各种非法形状(PackManifestError)
//   2. loadPackManifest / writePackManifest — 写→读 round-trip;损坏 JSON → PackManifestError
//   3. suggestionToManifest — 字段映射正确(source=discovered, skills, createdAt)
//   4. manifestToInstallPlan — 返回 skills 列表
//   5. diffManifest — 增删计算正确
//   6. PackManifestError.path 带正确路径

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PackManifestError,
  validatePackManifest,
  loadPackManifest,
  writePackManifest,
  suggestionToManifest,
  manifestToInstallPlan,
  diffManifest,
} from '../src/core/packs/pack-model.ts';
import type { PackManifest, PackSuggestion } from '../src/core/packs/types.ts';

// ── 临时目录管理 ──────────────────────────────────────────────────────────────

const TMP_DIRS: string[] = [];
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ss-packs-model-'));
  TMP_DIRS.push(dir);
});

afterAll(() => {
  for (const d of TMP_DIRS) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

// ── 测试用合法清单 ──────────────────────────────────────────────────────────

const VALID_MANIFEST: PackManifest = {
  version: 1,
  name: 'dev-trio',
  source: 'manual',
  skills: [
    { name: 'cloudflare' },
    { name: 'wrangler', repo: 'https://github.com/example/skills', commit: 'abc123' },
  ],
};

// ── 1. validatePackManifest ───────────────────────────────────────────────────

describe('validatePackManifest', () => {
  it('接受合法的完整清单', () => {
    const result = validatePackManifest(VALID_MANIFEST);
    expect(result.version).toBe(1);
    expect(result.name).toBe('dev-trio');
    expect(result.source).toBe('manual');
    expect(result.skills).toHaveLength(2);
  });

  it('接受带可选字段的清单(displayName, description, createdAt)', () => {
    const manifest = {
      ...VALID_MANIFEST,
      displayName: '开发三件套',
      description: '常用开发工具',
      createdAt: new Date().toISOString(),
    };
    expect(() => validatePackManifest(manifest)).not.toThrow();
  });

  it('接受 source=discovered', () => {
    const manifest = { ...VALID_MANIFEST, source: 'discovered' };
    expect(() => validatePackManifest(manifest)).not.toThrow();
  });

  it('接受空 skills 数组', () => {
    const manifest = { ...VALID_MANIFEST, skills: [] };
    expect(() => validatePackManifest(manifest)).not.toThrow();
  });

  it('接受带 ref 字段的 skill', () => {
    const manifest = {
      ...VALID_MANIFEST,
      skills: [{ name: 'foo', ref: 'main' }],
    };
    expect(() => validatePackManifest(manifest)).not.toThrow();
  });

  // 非法形状 → PackManifestError

  it('根节点不是对象 → PackManifestError', () => {
    expect(() => validatePackManifest('string')).toThrow(PackManifestError);
    expect(() => validatePackManifest(null)).toThrow(PackManifestError);
    expect(() => validatePackManifest([1, 2])).toThrow(PackManifestError);
  });

  it('version !== 1 → PackManifestError', () => {
    const bad = { ...VALID_MANIFEST, version: 2 };
    const err = (() => { try { validatePackManifest(bad, '/tmp/pack.json'); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(PackManifestError);
    expect((err as PackManifestError).path).toBe('/tmp/pack.json');
    expect((err as PackManifestError).message).toMatch(/version/);
  });

  it('version 缺失 → PackManifestError', () => {
    const { version: _v, ...noVersion } = VALID_MANIFEST;
    expect(() => validatePackManifest(noVersion)).toThrow(PackManifestError);
  });

  it('name 为空字符串 → PackManifestError', () => {
    const bad = { ...VALID_MANIFEST, name: '' };
    expect(() => validatePackManifest(bad)).toThrow(PackManifestError);
  });

  it('name 缺失 → PackManifestError', () => {
    const { name: _n, ...noName } = VALID_MANIFEST;
    expect(() => validatePackManifest(noName)).toThrow(PackManifestError);
  });

  it('name 为纯空格 → PackManifestError', () => {
    const bad = { ...VALID_MANIFEST, name: '   ' };
    expect(() => validatePackManifest(bad)).toThrow(PackManifestError);
  });

  it('source 非法值 → PackManifestError', () => {
    const bad = { ...VALID_MANIFEST, source: 'auto' };
    expect(() => validatePackManifest(bad)).toThrow(PackManifestError);
  });

  it('source 缺失 → PackManifestError', () => {
    const { source: _s, ...noSource } = VALID_MANIFEST;
    expect(() => validatePackManifest(noSource)).toThrow(PackManifestError);
  });

  it('skills 不是数组 → PackManifestError', () => {
    const bad = { ...VALID_MANIFEST, skills: 'cloudflare' };
    expect(() => validatePackManifest(bad)).toThrow(PackManifestError);
  });

  it('skills 元素不是对象 → PackManifestError', () => {
    const bad = { ...VALID_MANIFEST, skills: ['cloudflare'] };
    expect(() => validatePackManifest(bad)).toThrow(PackManifestError);
  });

  it('skills[i].name 缺失 → PackManifestError', () => {
    const bad = { ...VALID_MANIFEST, skills: [{ repo: 'https://example.com' }] };
    expect(() => validatePackManifest(bad)).toThrow(PackManifestError);
  });

  it('skills[i].name 为空字符串 → PackManifestError', () => {
    const bad = { ...VALID_MANIFEST, skills: [{ name: '' }] };
    expect(() => validatePackManifest(bad)).toThrow(PackManifestError);
  });

  it('skills[i].repo 不是字符串 → PackManifestError', () => {
    const bad = { ...VALID_MANIFEST, skills: [{ name: 'foo', repo: 123 }] };
    expect(() => validatePackManifest(bad)).toThrow(PackManifestError);
  });

  it('displayName 不是字符串 → PackManifestError', () => {
    const bad = { ...VALID_MANIFEST, displayName: 42 };
    expect(() => validatePackManifest(bad)).toThrow(PackManifestError);
  });

  it('PackManifestError 携带正确 path', () => {
    const customPath = '/some/dir/pack.json';
    let err: unknown;
    try {
      validatePackManifest({ version: 2 }, customPath);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PackManifestError);
    expect((err as PackManifestError).path).toBe(customPath);
    expect((err as PackManifestError).name).toBe('PackManifestError');
  });
});

// ── 2. loadPackManifest / writePackManifest ───────────────────────────────────

describe('loadPackManifest / writePackManifest', () => {
  it('写入再读取 round-trip(字段完全一致)', async () => {
    const filePath = join(dir, 'pack.json');
    await writePackManifest(filePath, VALID_MANIFEST);
    const loaded = await loadPackManifest(filePath);
    expect(loaded).toEqual(VALID_MANIFEST);
  });

  it('写入文件末尾有换行', async () => {
    const { readFile } = await import('node:fs/promises');
    const filePath = join(dir, 'pack.json');
    await writePackManifest(filePath, VALID_MANIFEST);
    const raw = await readFile(filePath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('写入内容是格式化 JSON(含缩进)', async () => {
    const { readFile } = await import('node:fs/promises');
    const filePath = join(dir, 'pack.json');
    await writePackManifest(filePath, VALID_MANIFEST);
    const raw = await readFile(filePath, 'utf8');
    // 格式化 JSON 有缩进行
    expect(raw).toContain('  "version"');
  });

  it('文件不存在 → PackManifestError(ENOENT)', async () => {
    const filePath = join(dir, 'missing.json');
    await expect(loadPackManifest(filePath)).rejects.toBeInstanceOf(PackManifestError);
  });

  it('损坏的 JSON → PackManifestError', async () => {
    const filePath = join(dir, 'broken.json');
    await writeFile(filePath, '{ this is not json ');
    await expect(loadPackManifest(filePath)).rejects.toBeInstanceOf(PackManifestError);
  });

  it('结构非法的 JSON → PackManifestError', async () => {
    const filePath = join(dir, 'bad-schema.json');
    await writeFile(filePath, JSON.stringify({ version: 99, name: '', source: 'wrong', skills: [] }));
    await expect(loadPackManifest(filePath)).rejects.toBeInstanceOf(PackManifestError);
  });

  it('PackManifestError.path 等于传入的文件路径', async () => {
    const filePath = join(dir, 'missing2.json');
    let err: unknown;
    try {
      await loadPackManifest(filePath);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PackManifestError);
    expect((err as PackManifestError).path).toBe(filePath);
  });
});

// ── 3. suggestionToManifest ───────────────────────────────────────────────────

describe('suggestionToManifest', () => {
  const suggestion: PackSuggestion = {
    id: 'abc',
    suggestedName: 'cf-stack',
    skills: ['cloudflare', 'wrangler', 'durable-objects'],
    rationale: '这3个在过去30天里一起出现了10次',
    strength: 0.85,
  };

  it('默认 source=discovered', () => {
    const m = suggestionToManifest(suggestion);
    expect(m.source).toBe('discovered');
  });

  it('skills 按建议顺序保留', () => {
    const m = suggestionToManifest(suggestion);
    expect(m.skills.map((s) => s.name)).toEqual(['cloudflare', 'wrangler', 'durable-objects']);
  });

  it('name 来自 suggestedName', () => {
    const m = suggestionToManifest(suggestion);
    expect(m.name).toBe('cf-stack');
  });

  it('version === 1', () => {
    const m = suggestionToManifest(suggestion);
    expect(m.version).toBe(1);
  });

  it('createdAt 是合法 ISO 字符串(且接近现在)', () => {
    const before = Date.now();
    const m = suggestionToManifest(suggestion);
    const after = Date.now();
    expect(typeof m.createdAt).toBe('string');
    const ts = new Date(m.createdAt!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('可覆盖 source=manual', () => {
    const m = suggestionToManifest(suggestion, { source: 'manual' });
    expect(m.source).toBe('manual');
  });

  it('opts.displayName / description 被写入', () => {
    const m = suggestionToManifest(suggestion, {
      displayName: 'CF 全家桶',
      description: '常用 Cloudflare 工具',
    });
    expect(m.displayName).toBe('CF 全家桶');
    expect(m.description).toBe('常用 Cloudflare 工具');
  });

  it('opts.skillRefs 被合并进对应 skill', () => {
    const m = suggestionToManifest(suggestion, {
      skillRefs: {
        wrangler: { repo: 'https://github.com/example/skills', commit: 'deadbeef' },
      },
    });
    const wrangler = m.skills.find((s) => s.name === 'wrangler');
    expect(wrangler?.repo).toBe('https://github.com/example/skills');
    expect(wrangler?.commit).toBe('deadbeef');
    // 其他 skill 不受影响
    const cf = m.skills.find((s) => s.name === 'cloudflare');
    expect(cf?.repo).toBeUndefined();
  });

  it('没有 opts 时不设 displayName/description', () => {
    const m = suggestionToManifest(suggestion);
    expect(m.displayName).toBeUndefined();
    expect(m.description).toBeUndefined();
  });
});

// ── 4. manifestToInstallPlan ─────────────────────────────────────────────────

describe('manifestToInstallPlan', () => {
  it('返回 { skills } 与 manifest.skills 内容相同', () => {
    const plan = manifestToInstallPlan(VALID_MANIFEST);
    expect(plan.skills).toEqual(VALID_MANIFEST.skills);
  });

  it('返回浅拷贝(修改结果不影响原 manifest)', () => {
    const plan = manifestToInstallPlan(VALID_MANIFEST);
    plan.skills.push({ name: 'extra' });
    expect(VALID_MANIFEST.skills).toHaveLength(2);
  });

  it('空 skills 清单 → 空安装列表', () => {
    const m: PackManifest = { ...VALID_MANIFEST, skills: [] };
    const plan = manifestToInstallPlan(m);
    expect(plan.skills).toHaveLength(0);
  });

  it('保持 skill 顺序', () => {
    const m: PackManifest = {
      ...VALID_MANIFEST,
      skills: [{ name: 'z' }, { name: 'a' }, { name: 'm' }],
    };
    const plan = manifestToInstallPlan(m);
    expect(plan.skills.map((s) => s.name)).toEqual(['z', 'a', 'm']);
  });
});

// ── 5. diffManifest ───────────────────────────────────────────────────────────

describe('diffManifest', () => {
  const baseManifest: PackManifest = {
    version: 1,
    name: 'base',
    source: 'manual',
    skills: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
  };

  it('新增 skill 出现在 added', () => {
    const next: PackManifest = { ...baseManifest, skills: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }] };
    const diff = diffManifest(baseManifest, next);
    expect(diff.added.map((s) => s.name)).toEqual(['d']);
    expect(diff.removed).toHaveLength(0);
  });

  it('删除 skill 出现在 removed', () => {
    const next: PackManifest = { ...baseManifest, skills: [{ name: 'a' }, { name: 'c' }] };
    const diff = diffManifest(baseManifest, next);
    expect(diff.removed.map((s) => s.name)).toEqual(['b']);
    expect(diff.added).toHaveLength(0);
  });

  it('无变化时 added/removed 均为空', () => {
    const diff = diffManifest(baseManifest, baseManifest);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('同时有增删', () => {
    const next: PackManifest = { ...baseManifest, skills: [{ name: 'b' }, { name: 'c' }, { name: 'x' }] };
    const diff = diffManifest(baseManifest, next);
    expect(diff.removed.map((s) => s.name)).toEqual(['a']);
    expect(diff.added.map((s) => s.name)).toEqual(['x']);
  });
});
