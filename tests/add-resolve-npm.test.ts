// add npm 解析层测试:registry 元数据 → 仓库地址;各种 repository 写法规范化;失败优雅。
import { describe, expect, it } from 'vitest';
import { normalizeRepoUrl, resolveNpmPackage } from '../src/core/add/resolve-npm.ts';

describe('normalizeRepoUrl', () => {
  it('git+https → https', () => {
    expect(normalizeRepoUrl('git+https://github.com/o/r.git')).toBe('https://github.com/o/r.git');
  });
  it('git:// → https://', () => {
    expect(normalizeRepoUrl('git://github.com/o/r.git')).toBe('https://github.com/o/r.git');
  });
  it('git@host:owner/repo → https', () => {
    expect(normalizeRepoUrl('git@github.com:o/r.git')).toBe('https://github.com/o/r.git');
  });
  it('github:owner/repo 简写', () => {
    expect(normalizeRepoUrl('github:o/r')).toBe('https://github.com/o/r.git');
  });
  it('普通 https 原样', () => {
    expect(normalizeRepoUrl('https://gitlab.com/o/r.git')).toBe('https://gitlab.com/o/r.git');
  });
  it('空 → undefined', () => {
    expect(normalizeRepoUrl('  ')).toBeUndefined();
  });
});

/** 造一个假 fetch,返回给定 JSON / 状态。 */
function fakeFetch(payload: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      json: async () => payload,
    }) as unknown as Response) as unknown as typeof fetch;
}

describe('resolveNpmPackage', () => {
  it('repository 为对象 {url} → 规范化 gitSource', async () => {
    const r = await resolveNpmPackage(
      'some-pkg',
      fakeFetch({ repository: { type: 'git', url: 'git+https://github.com/o/r.git' } }),
    );
    expect(r.gitSource).toBe('https://github.com/o/r.git');
    expect(r.error).toBeUndefined();
  });

  it('repository 为字符串简写', async () => {
    const r = await resolveNpmPackage('p', fakeFetch({ repository: 'github:o/r' }));
    expect(r.gitSource).toBe('https://github.com/o/r.git');
  });

  it('无 repository 字段 → 友好错误,引导改贴链接', async () => {
    const r = await resolveNpmPackage('p', fakeFetch({ name: 'p' }));
    expect(r.gitSource).toBeUndefined();
    expect(r.error).toMatch(/没有声明源码仓库|GitHub/);
  });

  it('registry 404 → 友好错误', async () => {
    const r = await resolveNpmPackage('missing', fakeFetch({}, false, 404));
    expect(r.error).toMatch(/404|找不到/);
  });

  it('网络异常 → 不抛,返回错误', async () => {
    const throwing = (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;
    const r = await resolveNpmPackage('p', throwing);
    expect(r.gitSource).toBeUndefined();
    expect(r.error).toMatch(/ENOTFOUND|出错/);
  });
});
