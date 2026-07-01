// C 线 · SkillsMP 源测试(opt-in + 用户自带 token)。
// 覆盖:① token 解析(显式 > env,空白→undefined);② Bearer 只发往 skillsmp.com、只进 header 不进 URL;
//       ③ 防御式归一化(多容器键 / 字段名变体 / 缺名丢弃 / 嵌套 repo);④ token 绝不进错误信息;
//       ⑤ searchRegistries:无 token 跳过(不联网)、有 token 才查、all 源缺 token 不影响 mcp。
// 全程 mock fetch,零真实网络。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchRegistries } from '../src/core/registry/index.ts';
import {
  SKILLSMP_TOKEN_ENV,
  normalizeSkill,
  resolveSkillsmpToken,
  searchSkillsMp,
} from '../src/core/registry/skillsmp.ts';

function jsonOk(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

const origToken = process.env[SKILLSMP_TOKEN_ENV];
afterEach(() => {
  if (origToken === undefined) delete process.env[SKILLSMP_TOKEN_ENV];
  else process.env[SKILLSMP_TOKEN_ENV] = origToken;
  vi.restoreAllMocks();
});

describe('SkillsMP · token 解析', () => {
  it('显式传入优先于环境变量', () => {
    process.env[SKILLSMP_TOKEN_ENV] = 'env-tok';
    expect(resolveSkillsmpToken('explicit-tok')).toBe('explicit-tok');
  });
  it('无显式则读环境变量,去首尾空白', () => {
    process.env[SKILLSMP_TOKEN_ENV] = '  env-tok  ';
    expect(resolveSkillsmpToken()).toBe('env-tok');
  });
  it('空白 / 未设 → undefined', () => {
    process.env[SKILLSMP_TOKEN_ENV] = '   ';
    expect(resolveSkillsmpToken()).toBeUndefined();
    delete process.env[SKILLSMP_TOKEN_ENV];
    expect(resolveSkillsmpToken()).toBeUndefined();
  });
});

describe('SkillsMP · 请求安全(Bearer 只进 header、只发 skillsmp.com)', () => {
  it('token 作为 Authorization: Bearer 发出,且不出现在 URL 里', async () => {
    let seenUrl = '';
    let seenAuth: string | null = null;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seenUrl = url;
      const h = new Headers(init?.headers);
      seenAuth = h.get('authorization');
      return jsonOk({ skills: [{ name: 'a', repository: { url: 'https://github.com/o/r' } }] });
    });
    await searchSkillsMp('fs', 'secret-token-123', { fetchImpl: fetchImpl as never });
    expect(seenAuth).toBe('Bearer secret-token-123');
    expect(seenUrl).toContain('https://skillsmp.com/api/v1/skills/search');
    expect(seenUrl).toContain('q=fs');
    // token 绝不进 URL
    expect(seenUrl).not.toContain('secret-token-123');
  });

  it('token 绝不出现在错误信息里(HTTP 错误)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('nope', { status: 401, headers: { 'content-type': 'application/json' } }),
    );
    const err = await searchSkillsMp('x', 'super-secret', { fetchImpl: fetchImpl as never }).catch((e) => e);
    expect(String(err?.message ?? err)).not.toContain('super-secret');
  });
});

describe('SkillsMP · 防御式归一化', () => {
  it('嵌套 repository.url + 描述/版本', () => {
    const e = normalizeSkill({
      name: 'cool-skill',
      description: 'does things',
      version: '2.0.0',
      repository: { url: 'https://github.com/owner/repo' },
      path: 'skills/cool',
    });
    expect(e).toMatchObject({
      id: 'cool-skill',
      name: 'cool-skill',
      source: 'skillsmp',
      sourceType: 'git',
      repositoryUrl: 'https://github.com/owner/repo',
      subdir: 'skills/cool',
      version: '2.0.0',
    });
  });
  it('平铺字段变体(githubUrl / summary / slug 作名)', () => {
    const e = normalizeSkill({ slug: 's1', summary: 'sum', githubUrl: 'https://github.com/a/b.git' });
    expect(e?.name).toBe('s1');
    expect(e?.description).toBe('sum');
    expect(e?.repositoryUrl).toBe('https://github.com/a/b.git');
  });
  it('通用 url 字段仅当像仓库地址才采信', () => {
    const detail = normalizeSkill({ name: 'x', url: 'https://skillsmp.com/skills/x' });
    expect(detail?.repositoryUrl).toBeUndefined();
    expect(detail?.sourceType).toBe('unknown');
    const repo = normalizeSkill({ name: 'y', url: 'https://github.com/o/y' });
    expect(repo?.repositoryUrl).toBe('https://github.com/o/y');
  });
  it('缺名字 → 丢弃;非对象 → undefined', () => {
    expect(normalizeSkill({ description: 'no name' })).toBeUndefined();
    expect(normalizeSkill('nope')).toBeUndefined();
    expect(normalizeSkill(null)).toBeUndefined();
  });
  it('多种容器键(data.results / results / items)都能取到条目', async () => {
    for (const body of [
      { results: [{ name: 'r1', repository: { url: 'https://github.com/o/r1' } }] },
      { items: [{ name: 'i1' }] },
      { data: { results: [{ name: 'd1' }] } },
    ]) {
      const fetchImpl = vi.fn(async () => jsonOk(body));
      const out = await searchSkillsMp('q', 'tok', { fetchImpl: fetchImpl as never });
      expect(out.length).toBe(1);
    }
  });
});

describe('SkillsMP · searchRegistries 集成', () => {
  it('source=skillsmp 但无 token → 跳过且不联网', async () => {
    delete process.env[SKILLSMP_TOKEN_ENV];
    const fetchImpl = vi.fn(async () => jsonOk({}));
    const res = await searchRegistries('fs', { source: 'skillsmp', fetchImpl: fetchImpl as never });
    expect(fetchImpl).not.toHaveBeenCalled();
    const sk = res.perSource.find((s) => s.source === 'skillsmp');
    expect(sk?.skipped).toContain('SKILLSMP_TOKEN');
    expect(sk?.entries).toEqual([]);
  });

  it('source=skillsmp + opts.skillsmpToken → 查询并归一化', async () => {
    const fetchImpl = vi.fn(async () => jsonOk({ skills: [{ name: 'z', repository: { url: 'https://github.com/o/z' } }] }));
    const res = await searchRegistries('fs', {
      source: 'skillsmp',
      skillsmpToken: 'tok',
      fetchImpl: fetchImpl as never,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.entries.map((e) => e.id)).toEqual(['z']);
  });

  it('查所有源但无 skillsmp token → skillsmp 跳过,mcp 仍照常', async () => {
    delete process.env[SKILLSMP_TOKEN_ENV];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('skillsmp.com')) throw new Error('不该调用 skillsmp');
      return jsonOk({ servers: [{ server: { name: 'mcp1' } }] });
    });
    const res = await searchRegistries('fs', { fetchImpl: fetchImpl as never });
    const sk = res.perSource.find((s) => s.source === 'skillsmp');
    expect(sk?.skipped).toBeTruthy();
    expect(res.entries.some((e) => e.source === 'mcp')).toBe(true);
  });
});

describe('SkillsMP · HTTPS-only 继承', () => {
  it('http:// base 被拒(底层 fetch.ts 护栏)', async () => {
    await expect(
      searchSkillsMp('x', 'tok', { base: 'http://skillsmp.com', fetchImpl: vi.fn() as never }),
    ).rejects.toMatchObject({ code: 'insecure-url' });
  });
});
