// R29-a:性能回归守卫——大量 skill 场景下,核心读路径不得出现超线性劣化。
//
// 基准测量值(N=200 skills,开发机 Apple M 系列,vitest 进程内):
//   scanHome:    ~13ms(改后;改前 ~17ms)
//   runDoctor:   ~6ms
//   auditHome:   ~50ms
//
// 守卫阈值取「测量值 × 10」再向上取整到最近 500ms 档,留出宽裕的 CI 余量,
// 防止慢机、高负载、磁盘 I/O 抖动造成偶发失败。
// 目的是发现将来引入的 O(n²) 或大量重复 I/O,而非精确计时。
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { auditHome } from '../src/cli/commands/audit.ts';
import { runDoctor } from '../src/core/doctor.ts';
import { scanHome } from '../src/core/scan.ts';
import { getSkillsLockPath } from '../src/core/lock.ts';
import { getSkillsJsonPath } from '../src/core/sync.ts';

// ── 合成 home 配置 ──────────────────────────────────────────────────────────
const N = 200; // skill 数量;足够暴露超线性,同时不让测试时间太长

// ── 守卫阈值(毫秒,宽松)────────────────────────────────────────────────────
// 各值 ≈ 基准测量 × 10,防止慢 CI 机器偶发超时。
const SCAN_LIMIT_MS = 500;    // 基准 ~13ms × 10 = 130ms;取 500ms 保守
const DOCTOR_LIMIT_MS = 500;  // 基准 ~6ms × 10 = 60ms;取 500ms 保守
const AUDIT_LIMIT_MS = 3000;  // 基准 ~50ms × 10 = 500ms;auditHome 读文件较多取 3s

// ── 临时目录 ─────────────────────────────────────────────────────────────────
let home: string;
let homeReady = false;

// setup:在 describe 之外用立即执行异步函数构建 home,避免 beforeAll 跨 it 泄露状态
const setupPromise = (async () => {
  home = mkdtempSync(join(tmpdir(), 'ss-r29a-perf-'));

  const claudeSkillsDir = join(home, '.claude', 'skills');
  await mkdir(claudeSkillsDir, { recursive: true });
  await mkdir(join(home, '.skill-switch'), { recursive: true });

  const skillNames: string[] = [];
  for (let i = 0; i < N; i++) {
    const name = `skill-${String(i).padStart(4, '0')}`;
    skillNames.push(name);
    const skillDir = join(claudeSkillsDir, name);
    await mkdir(skillDir, { recursive: true });
    // SKILL.md:正常 frontmatter
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Perf-guard skill ${i}.\n---\n# ${name}\n详细内容 ${i}。\n`,
    );
    // 额外小文件,让 auditHome 有内容可扫描(与真实 skill 结构接近)
    await writeFile(join(skillDir, 'extra.md'), `Extra for ${name}.\n`);
  }

  // skills.json 声明:全部 disabled,doctor 只走"declared → lock → disk"对账路径
  const decl = {
    version: 1,
    skills: skillNames.map((name) => ({
      name,
      source: join(claudeSkillsDir, name),
      agents: ['claude-code'],
      enabled: false,
      mode: 'copy',
    })),
  };
  await writeFile(getSkillsJsonPath(home), JSON.stringify(decl, null, 2));
  // 空锁文件
  await writeFile(getSkillsLockPath(home), JSON.stringify({ version: 1, skills: [] }, null, 2));

  // 预热:JIT 初始化开销不计入守卫
  await scanHome(home);
  await runDoctor(home);
  await auditHome(home);

  homeReady = true;
})();

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe(`R29-a perf guard (N=${N} skills)`, () => {
  it('setupPromise completes without error', async () => {
    await setupPromise;
    expect(homeReady).toBe(true);
  });

  it(`scanHome completes within ${SCAN_LIMIT_MS}ms`, async () => {
    await setupPromise;
    const t0 = performance.now();
    const records = await scanHome(home);
    const elapsed = performance.now() - t0;
    // 行为验证:返回正确数量
    expect(records).toHaveLength(N);
    // 性能守卫
    expect(elapsed).toBeLessThan(SCAN_LIMIT_MS);
  });

  it(`runDoctor completes within ${DOCTOR_LIMIT_MS}ms`, async () => {
    await setupPromise;
    const t0 = performance.now();
    const report = await runDoctor(home);
    const elapsed = performance.now() - t0;
    // 行为验证:声明里全是 disabled,clean 且无 finding
    expect(report.clean).toBe(true);
    expect(report.findings).toHaveLength(0);
    // 性能守卫
    expect(elapsed).toBeLessThan(DOCTOR_LIMIT_MS);
  });

  it(`auditHome completes within ${AUDIT_LIMIT_MS}ms`, async () => {
    await setupPromise;
    const t0 = performance.now();
    const report = await auditHome(home);
    const elapsed = performance.now() - t0;
    // 行为验证:N 个 skill 均被扫描
    expect(report.total).toBe(N);
    expect(report.skills).toHaveLength(N);
    // 性能守卫
    expect(elapsed).toBeLessThan(AUDIT_LIMIT_MS);
  });
});
