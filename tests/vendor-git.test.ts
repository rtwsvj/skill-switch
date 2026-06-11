// S3.2:新增 vendor 文件(方案 A)的接线 smoke 测试。
// 深度行为(实际 clone)在 S3.3 install 切片用本地 file:// 仓 fixture 验证;
// 这里只验证导入可用 + 纯函数解析正确,不触网。
import { describe, expect, it } from 'vitest';
import {
  isGitHubHttpsCloneUrl,
  parseGitHubRepoUrl,
} from '../src/vendor/vercel-skills/git.ts';
import { parseSource } from '../src/vendor/vercel-skills/source-parser.ts';
import {
  computeSkillFolderHash,
  getLocalLockPath,
} from '../src/vendor/vercel-skills/local-lock.ts';

describe('vendor: git.ts (pure helpers)', () => {
  it('parses a GitHub repo url', () => {
    const info = parseGitHubRepoUrl('https://github.com/vercel-labs/skills');
    expect(info?.owner).toBe('vercel-labs');
    expect(info?.repo).toBe('skills');
  });

  it('recognizes https clone urls', () => {
    expect(isGitHubHttpsCloneUrl('https://github.com/a/b')).toBe(true);
    expect(isGitHubHttpsCloneUrl('git@github.com:a/b.git')).toBe(false);
  });
});

describe('vendor: source-parser.ts', () => {
  it('parses an owner/repo shorthand into a structured source', () => {
    const parsed = parseSource('vercel-labs/skills');
    expect(parsed).toBeTruthy();
    expect(JSON.stringify(parsed)).toContain('skills');
  });
});

describe('vendor: local-lock.ts', () => {
  it('resolves a lock path under the given cwd', () => {
    const p = getLocalLockPath('/tmp/project-x');
    expect(p).toContain('/tmp/project-x');
  });

  it('hashes a skill folder deterministically (this repo dir)', async () => {
    const dir = new URL('./fixtures/home-basic/.claude/skills/git-helper', import.meta.url)
      .pathname;
    const h1 = await computeSkillFolderHash(dir);
    const h2 = await computeSkillFolderHash(dir);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{8,}$/);
  });
});
