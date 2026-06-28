// P3-D10 Golden/Snapshot 测试扩面
// 为 audit(human+json)、doctor、add --dry-run 的 stdout 各加 toMatchSnapshot,
// 防止输出格式/exit code 悄悄回归。固定 fixture + 标准化路径,确保快照稳定可重现。
//
// 设计原则:
//   - audit human/json:直接调用 src/ 函数(零子进程,最快)
//   - doctor:真实子进程 + 临时 home(行为完全还原)
//   - add --dry-run:真实子进程 + 本地 file:// git 仓(零网络)
//   - 所有绝对路径都标准化为占位符,保证快照跨机器一致

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditSkillDir, formatAuditReport } from '../src/cli/commands/audit.ts';

// 含真实子进程(doctor/add --dry-run)的用例需要较长超时
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// ── 路径常量 ─────────────────────────────────────────────────────────────────
const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');
const FIX = join(import.meta.dirname, 'fixtures');
// 使用固定良性 skill(api-client)作为 audit 快照基准:内容固定不变
const BENIGN_SKILL = join(FIX, 'skills-benign', 'api-client');
// 使用固定恶意 skill(revshell-dev-tcp)测试有 findings 的输出
const MALICIOUS_SKILL = join(FIX, 'skills-malicious', 'revshell-dev-tcp');

// ── 子进程辅助 ───────────────────────────────────────────────────────────────
function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', CLI, ...args],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
}

// ── 1. audit human 格式快照(直接调用 formatAuditReport,零子进程)──────────────
describe('audit human 格式 golden snapshot', () => {
  it('良性 skill(api-client):formatAuditReport 输出匹配快照', async () => {
    const report = await auditSkillDir(BENIGN_SKILL);
    // 标准化路径:不含绝对路径时直接 snapshot
    const output = formatAuditReport(BENIGN_SKILL, report);
    // 用占位符替换绝对路径,使快照跨机器稳定
    const normalized = output.replaceAll(BENIGN_SKILL, '<skill-dir>');
    expect(normalized).toMatchSnapshot();
  });

  it('恶意 skill(revshell-dev-tcp):formatAuditReport 有 findings,匹配快照', async () => {
    const report = await auditSkillDir(MALICIOUS_SKILL);
    const output = formatAuditReport(MALICIOUS_SKILL, report);
    const normalized = output.replaceAll(MALICIOUS_SKILL, '<skill-dir>');
    expect(normalized).toMatchSnapshot();
    // 额外断言:有 critical finding + exit 相关属性存在
    expect(report.findings.some((f) => f.severity === 'critical')).toBe(true);
  });
});

// ── 2. audit JSON 格式快照(直接调用 auditSkillDir,零子进程)────────────────────
describe('audit JSON 格式 golden snapshot', () => {
  it('良性 skill(api-client):JSON 序列化匹配快照', async () => {
    const report = await auditSkillDir(BENIGN_SKILL);
    // 只序列化稳定字段:findings/score/verdict;coverage 数字随文件大小浮动略去
    const stable = {
      findings: report.findings,
      score: report.score,
      verdict: report.verdict,
    };
    expect(stable).toMatchSnapshot();
  });

  it('恶意 skill(revshell-dev-tcp):JSON 含 ruleId/severity/file/line,匹配快照', async () => {
    const report = await auditSkillDir(MALICIOUS_SKILL);
    // 序列化 findings 的核心字段;excerpt 含行文(稳定),一并快照
    const stable = {
      findings: report.findings.map((f) => ({
        ruleId: f.ruleId,
        severity: f.severity,
        file: f.file,
        line: f.line,
        message: f.message,
      })),
      score: report.score,
      verdict: report.verdict,
    };
    expect(stable).toMatchSnapshot();
  });
});

// ── 3. doctor golden snapshot(真实子进程) ────────────────────────────────────
// 需要构造一个干净对齐的 home;复用 doctor-cli.test.ts 中的对齐模式
import { computeSkillFolderHash } from '../src/vendor/vercel-skills/local-lock.ts';
import { getSkillsLockPath, upsertLockEntries } from '../src/core/lock.ts';
import { applySync, getSkillsJsonPath, type SkillsDeclarationFile } from '../src/core/sync.ts';

let doctorHome: string;

async function setUpAlignedHome(home: string): Promise<void> {
  const src = join(home, '.skill-switch', 'store', 'golden-skill');
  await mkdir(src, { recursive: true });
  await writeFile(join(src, 'SKILL.md'), '---\nname: golden-skill\ndescription: golden fixture.\n---\nNo issues.\n');
  const decl: SkillsDeclarationFile = {
    version: 1,
    skills: [{ name: 'golden-skill', source: src, agents: ['claude-code'], enabled: true, mode: 'copy' }],
  };
  await mkdir(join(home, '.skill-switch'), { recursive: true });
  await writeFile(getSkillsJsonPath(home), `${JSON.stringify(decl, null, 2)}\n`);
  await applySync(home, decl);
  await upsertLockEntries(getSkillsLockPath(home), [
    {
      name: 'golden-skill',
      agent: 'claude-code',
      source: src,
      sourceType: 'local',
      sha256: await computeSkillFolderHash(join(home, '.claude', 'skills', 'golden-skill')),
      mode: 'copy',
    },
  ]);
}

beforeAll(async () => {
  doctorHome = mkdtempSync(join(tmpdir(), 'ss-golden-doctor-'));
  await setUpAlignedHome(doctorHome);
});

describe('doctor stdout golden snapshot', () => {
  it('干净 home --ci:exit 0,human 输出匹配快照', () => {
    const r = runCli(['doctor', '--home', doctorHome, '--ci']);
    expect(r.status).toBe(0);
    // 规范化 home 绝对路径
    const normalized = r.stdout.replaceAll(doctorHome, '<home>');
    expect(normalized).toMatchSnapshot();
  });

  it('干净 home --json:exit 0,JSON 输出匹配快照', () => {
    const r = runCli(['doctor', '--home', doctorHome, '--json']);
    expect(r.status).toBe(0);
    // 解析后再序列化:规范化路径避免绝对路径入快照
    const parsed = JSON.parse(r.stdout.replaceAll(doctorHome, '<home>')) as unknown;
    expect(parsed).toMatchSnapshot();
  });
});

// ── 4. add --dry-run golden snapshot(本地 file:// git 仓,零网络)────────────────
let addWork: string;
let safeSkillRepo: string; // 只含一个良性 skill 的本地 git 仓

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    stdio: 'pipe',
  });
}

beforeAll(async () => {
  addWork = mkdtempSync(join(tmpdir(), 'ss-golden-add-'));
  safeSkillRepo = join(addWork, 'safe-repo');
  await mkdir(join(safeSkillRepo, 'helpful-notes'), { recursive: true });
  await writeFile(
    join(safeSkillRepo, 'helpful-notes', 'SKILL.md'),
    '---\nname: helpful-notes\ndescription: Keep notes tidy.\n---\nNothing dangerous here.\n',
  );
  execFileSync('git', ['init', '-q', safeSkillRepo]);
  git(safeSkillRepo, 'add', '-A');
  git(safeSkillRepo, 'commit', '-qm', 'init');
});

afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(addWork, { recursive: true, force: true }).catch(() => {});
  await rm(doctorHome, { recursive: true, force: true }).catch(() => {});
});

describe('add --dry-run stdout golden snapshot', () => {
  it('单个良性 skill 仓:exit 0,human 输出含 skill 名称且匹配快照', () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-golden-add-home-'));
    const r = runCli(['add', `file://${safeSkillRepo}`, '--home', home, '--dry-run']);
    expect(r.status).toBe(0);
    // 标准化:绝对路径 + 仓库路径
    const normalized = r.stdout
      .replaceAll(safeSkillRepo, '<repo>')
      .replaceAll(home, '<home>');
    expect(normalized).toMatchSnapshot();
    // 额外断言:确保 skill 名出现在输出里
    expect(r.stdout).toContain('helpful-notes');
    // dry-run 绝不安装
    expect(r.stdout).not.toMatch(/已安装/);
  });

  it('add --dry-run --json:exit 0,JSON 结构匹配快照', () => {
    const home = mkdtempSync(join(tmpdir(), 'ss-golden-add-home-'));
    const r = runCli(['add', `file://${safeSkillRepo}`, '--home', home, '--dry-run', '--json']);
    expect(r.status).toBe(0);
    const raw = r.stdout.replaceAll(safeSkillRepo, '<repo>').replaceAll(home, '<home>');
    // 解析后序列化:只快照稳定字段(候选名/verdict;排除 relPath 里的 tmp 目录前缀)
    const parsed = JSON.parse(raw) as {
      preview: { parsed: { kind: string; gitSource?: string }; candidates: Array<{ name: string; verdict: string; blocked: boolean }> };
      installed: unknown[];
      note: string;
    };
    const stable = {
      note: parsed.note,
      installedCount: parsed.installed.length,
      parsedKind: parsed.preview.parsed.kind,
      candidates: parsed.preview.candidates.map((c) => ({
        name: c.name,
        verdict: c.verdict,
        blocked: c.blocked,
      })),
    };
    expect(stable).toMatchSnapshot();
  });
});
