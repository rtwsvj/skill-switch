// add 编排层(预览):粘贴内容 → 解析 →(npm 则只读解析 registry)→ 克隆(只读)→
// 发现全部 skill → 逐个审计 → 返回候选 + 裁决。**不含任何写动作。**
import { relative } from 'node:path';
import { auditSkillDir, shouldBlock } from '../../cli/commands/audit.ts';
import { cleanupTempDir, cloneRepo } from '../../vendor/vercel-skills/git.ts';
import { assertSafeGitSource } from '../git-safe.ts';
import { discoverSkillDirs } from '../install.ts';
import { parseSource } from './parse-source.ts';
import { resolveNpmPackage } from './resolve-npm.ts';
import type { AddPreview, ParsedSource, SkillCandidate } from './types.ts';

export interface PreviewAddOptions {
  /** 注入 fetch(测试用);默认全局 fetch。 */
  fetchImpl?: typeof fetch;
}

/** 给定一个克隆好的根目录 + 可选子目录,发现并审计全部 skill。 */
async function auditAllSkills(root: string, subdir?: string): Promise<SkillCandidate[]> {
  const all = await discoverSkillDirs(root);
  const prefix = subdir ? `${root.replace(/\/$/, '')}/${subdir.replace(/^\/|\/$/g, '')}` : root;
  const dirs = subdir
    ? all.filter((d) => d === prefix || d.startsWith(`${prefix}/`))
    : all;

  const candidates: SkillCandidate[] = [];
  for (const dir of dirs) {
    const report = await auditSkillDir(dir);
    candidates.push({
      name: dir.split('/').pop() ?? dir,
      relPath: relative(root, dir),
      verdict: report.verdict,
      score: report.score,
      blocked: shouldBlock(report),
      // 内容安全:只取 ruleId/severity/message,绝不带命中行文或密钥
      findings: report.findings.map((f) => ({
        ruleId: f.ruleId,
        severity: f.severity,
        message: f.message,
      })),
    });
  }
  return candidates;
}

/**
 * 解析 + 克隆 + 审计,得到候选 skill 预览(不安装)。
 * 任何环节出问题都不抛,装进 AddPreview.error 优雅返回。
 */
export async function previewAdd(
  rawInput: string,
  opts: PreviewAddOptions = {},
): Promise<AddPreview> {
  const parsed: ParsedSource = parseSource(rawInput);

  // unsupported(curl|bash、无法识别)→ 直接带原因返回
  if (parsed.kind === 'unsupported') {
    return { parsed, candidates: [], error: parsed.note };
  }

  // npm 包名 → 只读查 registry 拿仓库地址
  if (parsed.kind === 'npm' && parsed.npmPackage && !parsed.gitSource) {
    const res = await resolveNpmPackage(parsed.npmPackage, opts.fetchImpl);
    if (!res.gitSource) {
      return { parsed, candidates: [], error: res.error };
    }
    parsed.gitSource = res.gitSource;
  }

  if (!parsed.gitSource) {
    return { parsed, candidates: [], error: '没有解析出可克隆的 git 来源。' };
  }

  // 克隆前安全校验(拦下危险传输形式)
  try {
    assertSafeGitSource(parsed.gitSource);
  } catch (e) {
    return { parsed, candidates: [], error: e instanceof Error ? e.message : String(e) };
  }

  let tempDir: string | undefined;
  try {
    tempDir = await cloneRepo(parsed.gitSource, parsed.ref);
    const candidates = await auditAllSkills(tempDir, parsed.subdir);
    if (candidates.length === 0) {
      return {
        parsed,
        candidates: [],
        error: parsed.subdir
          ? `子目录 ${parsed.subdir} 里没有发现 skill(含 SKILL.md 的目录)。`
          : '来源仓库里没有发现 skill(含 SKILL.md 的目录)。',
      };
    }
    return { parsed, candidates };
  } catch (e) {
    return { parsed, candidates: [], error: `克隆/审计失败:${e instanceof Error ? e.message : String(e)}` };
  } finally {
    if (tempDir) await cleanupTempDir(tempDir).catch(() => {});
  }
}
