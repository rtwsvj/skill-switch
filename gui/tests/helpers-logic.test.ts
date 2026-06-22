// R32-a:GUI 纯逻辑覆盖 —— helpers.ts 中所有未被测试的纯函数与数据层边界。
// 不依赖 Tauri 运行时或浏览器,headless vitest 即可全量运行。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  sectionsForScreen,
  cx,
  isNameMismatch,
  isBlockingAudit,
  displaySkillName,
  actionSkillName,
  isSkillEnabled,
  mergeDeclaredSkills,
  skillAgentKey,
  isWriteBusy,
  agentOptions,
  changedActionCount,
  syncActionLabel,
  snapshotPaths,
  isRestoreList,
  verdictLabel,
  severityLabel,
  doctorKindLabel,
  driftTone,
  doctorHint,
  createConfirmationDialogState,
  initialSectionStates,
  advancedStorageKey,
  onboardedStorageKey,
  readStoredAdvanced,
  readStoredOnboarded,
} from '../src/lib/helpers';
import { createI18nForLanguage } from '../src/i18n';
import type { AuditReport, DashboardData, DoctorDeclaration, DoctorReport, LockVerifyReport, ScanReport, SkillRecord, StatsReport } from '../src/data/types';
import type { Screen } from '../src/lib/types';

// ── 辅助工厂 ───────────────────────────────────────────────────
function makeSkill(partial: Partial<SkillRecord> & { dirName: string; agents: string[] }): SkillRecord {
  return {
    relSkillsDir: '.claude/skills',
    dir: `/h/${partial.dirName}`,
    path: `/h/${partial.dirName}/SKILL.md`,
    ...partial,
  };
}

const emptyScan: ScanReport = { home: '/h', total: 0, skills: [] };
const emptyDoctor: DoctorReport = {
  findings: [],
  clean: true,
  checked: { declared: 0, locked: 0 },
  declarations: [],
};
const emptyStats: StatsReport = { scannedFiles: 0, invocations: 0, usage: [], zombies: [] };
const emptyLockVerify: LockVerifyReport = { ok: true, lockPath: '/lock', entries: [] };

function makeDashboard(partial: Partial<DashboardData> = {}): DashboardData {
  return {
    scan: emptyScan,
    audit: [],
    doctor: emptyDoctor,
    stats: emptyStats,
    lockVerify: emptyLockVerify,
    source: 'fixtures',
    loadedAt: new Date().toISOString(),
    ...partial,
  };
}

// ── sectionsForScreen ─────────────────────────────────────────
describe('sectionsForScreen', () => {
  it('overview → audit + stats(同时消费两个懒加载区块)', () => {
    const sections = sectionsForScreen('overview');
    expect(sections).toContain('audit');
    expect(sections).toContain('stats');
    expect(sections.length).toBe(2);
  });

  it('audit → audit + configAudit', () => {
    const sections = sectionsForScreen('audit');
    expect(sections).toContain('audit');
    expect(sections).toContain('configAudit');
    expect(sections.length).toBe(2);
  });

  it('stats → 只有 stats', () => {
    expect(sectionsForScreen('stats')).toEqual(['stats']);
  });

  it('skills / history → 空数组(无懒加载区块)', () => {
    expect(sectionsForScreen('skills')).toEqual([]);
    expect(sectionsForScreen('history')).toEqual([]);
  });

  // 边界:全部五个屏幕都有明确映射,无 undefined
  it.each(['overview', 'skills', 'audit', 'history', 'stats'] as Screen[])(
    '所有屏幕(%s)返回数组(不抛)', (screen) => {
      expect(() => sectionsForScreen(screen)).not.toThrow();
      expect(Array.isArray(sectionsForScreen(screen))).toBe(true);
    },
  );
});

// ── cx(classname util) ───────────────────────────────────────
describe('cx', () => {
  it('拼接字符串部分', () => {
    expect(cx('a', 'b', 'c')).toBe('a b c');
  });

  it('过滤掉 false / undefined', () => {
    expect(cx('a', false, 'b', undefined)).toBe('a b');
  });

  it('所有部分都为假值 → 空字符串', () => {
    expect(cx(false, undefined, false)).toBe('');
  });

  it('单个部分', () => {
    expect(cx('only')).toBe('only');
  });
});

// ── isNameMismatch ────────────────────────────────────────────
describe('isNameMismatch', () => {
  it('name === dirName → 无歧义', () => {
    expect(isNameMismatch(makeSkill({ dirName: 'foo', agents: [], name: 'foo' }))).toBe(false);
  });

  it('name 与 dirName 不同 → 歧义', () => {
    expect(isNameMismatch(makeSkill({ dirName: 'foo-v2', agents: [], name: 'foo' }))).toBe(true);
  });

  it('无 name 字段 → 无歧义(未设置不算不匹配)', () => {
    expect(isNameMismatch(makeSkill({ dirName: 'bar', agents: [] }))).toBe(false);
  });
});

// ── isBlockingAudit ───────────────────────────────────────────
describe('isBlockingAudit', () => {
  const base: AuditReport = { path: '/x', findings: [], score: 100, verdict: 'SAFE' };

  it('score ≥ 70 且无 critical/high → 不阻断', () => {
    expect(isBlockingAudit({ ...base, score: 75 })).toBe(false);
  });

  it('score < 70 → 阻断(分数线)', () => {
    expect(isBlockingAudit({ ...base, score: 69 })).toBe(true);
  });

  it('score = 70 → 不阻断(边界恰好在线上)', () => {
    expect(isBlockingAudit({ ...base, score: 70 })).toBe(false);
  });

  it('critical finding → 阻断', () => {
    const report: AuditReport = {
      ...base,
      score: 90,
      findings: [{ ruleId: 'x', severity: 'critical', file: 'f', line: 1, excerpt: '', message: '' }],
    };
    expect(isBlockingAudit(report)).toBe(true);
  });

  it('high finding → 阻断', () => {
    const report: AuditReport = {
      ...base,
      score: 85,
      findings: [{ ruleId: 'x', severity: 'high', file: 'f', line: 1, excerpt: '', message: '' }],
    };
    expect(isBlockingAudit(report)).toBe(true);
  });

  it('medium/low finding → 不阻断', () => {
    const report: AuditReport = {
      ...base,
      score: 80,
      findings: [{ ruleId: 'x', severity: 'medium', file: 'f', line: 1, excerpt: '', message: '' }],
    };
    expect(isBlockingAudit(report)).toBe(false);
  });

  it('blocked 字段显式为 true → 强制阻断(高于分数/发现)', () => {
    expect(isBlockingAudit({ ...base, score: 100, blocked: true })).toBe(true);
  });

  it('findings 缺失(undefined) → 不抛', () => {
    // 旧 CLI 输出可能无 findings 字段
    expect(() => isBlockingAudit({ path: '/x', score: 100, verdict: 'SAFE' } as AuditReport)).not.toThrow();
  });
});

// ── displaySkillName / actionSkillName ────────────────────────
describe('displaySkillName', () => {
  it('优先返回 name', () => {
    expect(displaySkillName(makeSkill({ dirName: 'dir', agents: [], name: 'pretty-name' }))).toBe('pretty-name');
  });

  it('无 name 时回退 dirName', () => {
    expect(displaySkillName(makeSkill({ dirName: 'dir', agents: [] }))).toBe('dir');
  });
});

describe('actionSkillName', () => {
  it('始终返回 dirName(CLI 操作用目录名,不受 name 影响)', () => {
    expect(actionSkillName(makeSkill({ dirName: 'dir-slug', agents: [], name: 'pretty' }))).toBe('dir-slug');
  });
});

// ── isSkillEnabled ────────────────────────────────────────────
describe('isSkillEnabled', () => {
  it('enabled=true → true', () => {
    expect(isSkillEnabled(makeSkill({ dirName: 'a', agents: [], enabled: true }))).toBe(true);
  });

  it('enabled=false → false', () => {
    expect(isSkillEnabled(makeSkill({ dirName: 'a', agents: [], enabled: false }))).toBe(false);
  });

  it('enabled 未设置 → 默认 true', () => {
    expect(isSkillEnabled(makeSkill({ dirName: 'a', agents: [] }))).toBe(true);
  });
});

// ── skillAgentKey ─────────────────────────────────────────────
describe('skillAgentKey', () => {
  it('格式为 agent/name', () => {
    expect(skillAgentKey('claude-code', 'foo')).toBe('claude-code/foo');
  });
});

// ── isWriteBusy ───────────────────────────────────────────────
describe('isWriteBusy', () => {
  it('null → 不忙', () => {
    expect(isWriteBusy(null)).toBe(false);
  });

  it('sync-dry-run → 不阻塞(只读)', () => {
    expect(isWriteBusy('sync-dry-run')).toBe(false);
  });

  it('restore-list → 不阻塞(只读)', () => {
    expect(isWriteBusy('restore-list')).toBe(false);
  });

  it('install → 忙', () => {
    expect(isWriteBusy('install')).toBe(true);
  });

  it('toggle → 忙', () => {
    expect(isWriteBusy('toggle')).toBe(true);
  });

  it('sync → 忙', () => {
    expect(isWriteBusy('sync')).toBe(true);
  });
});

// ── agentOptions ──────────────────────────────────────────────
describe('agentOptions', () => {
  it('包含所有 fallback agents', () => {
    const options = agentOptions(makeDashboard());
    expect(options).toContain('claude-code');
    expect(options).toContain('codex');
    expect(options).toContain('cursor');
  });

  it('合并 scan 里的额外 agent', () => {
    const data = makeDashboard({
      scan: {
        home: '/h',
        total: 1,
        skills: [makeSkill({ dirName: 'sk', agents: ['my-custom-agent'] })],
      },
    });
    expect(agentOptions(data)).toContain('my-custom-agent');
  });

  it('去重(agent 在多个技能里出现时只保留一次)', () => {
    const data = makeDashboard({
      scan: {
        home: '/h',
        total: 2,
        skills: [
          makeSkill({ dirName: 'a', agents: ['claude-code'] }),
          makeSkill({ dirName: 'b', agents: ['claude-code'] }),
        ],
      },
    });
    const options = agentOptions(data);
    expect(options.filter((x) => x === 'claude-code').length).toBe(1);
  });
});

// ── changedActionCount ────────────────────────────────────────
describe('changedActionCount', () => {
  it('只统计非 noop 动作', () => {
    const result = {
      declarationPath: '/d',
      dryRun: false,
      snapshots: [],
      actions: [
        { kind: 'noop' as const, agent: 'a', name: 'n1', target: '/t' },
        { kind: 'create' as const, agent: 'a', name: 'n2', target: '/t' },
        { kind: 'remove' as const, agent: 'a', name: 'n3', target: '/t' },
      ],
    };
    expect(changedActionCount(result)).toBe(2);
  });

  it('全 noop → 0', () => {
    const result = {
      declarationPath: '/d',
      dryRun: true,
      snapshots: [],
      actions: [{ kind: 'noop' as const, agent: 'a', name: 'n', target: '/t' }],
    };
    expect(changedActionCount(result)).toBe(0);
  });

  it('空 actions → 0', () => {
    const result = { declarationPath: '/d', dryRun: false, snapshots: [], actions: [] };
    expect(changedActionCount(result)).toBe(0);
  });
});

// ── syncActionLabel ───────────────────────────────────────────
describe('syncActionLabel', () => {
  let t: Awaited<ReturnType<typeof createI18nForLanguage>>['t'];
  beforeEach(async () => {
    const i18n = await createI18nForLanguage('en');
    t = i18n.t.bind(i18n);
  });

  it('create → "Add <target>"', () => {
    const label = syncActionLabel({ kind: 'create', agent: 'claude-code', name: 'foo' }, t);
    expect(label).toBe('Add claude-code / foo');
  });

  it('replace → "Update <target>"', () => {
    const label = syncActionLabel({ kind: 'replace', agent: 'codex', name: 'bar' }, t);
    expect(label).toBe('Update codex / bar');
  });

  it('remove → "Remove <target>"', () => {
    expect(syncActionLabel({ kind: 'remove', agent: 'a', name: 'b' }, t)).toBe('Remove a / b');
  });

  it('config-disable → "Disable <target>"', () => {
    expect(syncActionLabel({ kind: 'config-disable', agent: 'a', name: 'b' }, t)).toBe('Disable a / b');
  });

  it('config-enable → "Enable <target>"', () => {
    expect(syncActionLabel({ kind: 'config-enable', agent: 'a', name: 'b' }, t)).toBe('Enable a / b');
  });

  it('未知 kind → 降级 "Change <target>"', () => {
    expect(syncActionLabel({ kind: 'unknown-future-op', agent: 'a', name: 'b' }, t)).toBe('Change a / b');
  });
});

// ── snapshotPaths ─────────────────────────────────────────────
describe('snapshotPaths', () => {
  it('全空 → 空数组', () => {
    expect(snapshotPaths({})).toEqual([]);
  });

  it('只有 snapshotPath', () => {
    expect(snapshotPaths({ snapshotPath: '/a' })).toEqual(['/a']);
  });

  it('只有 snapshots 数组', () => {
    expect(snapshotPaths({ snapshots: [{ path: '/b' }, { path: '/c' }] })).toEqual(['/b', '/c']);
  });

  it('只有 safetySnapshot', () => {
    expect(snapshotPaths({ safetySnapshot: { path: '/d' } })).toEqual(['/d']);
  });

  it('三者都有 → 全部合并,顺序为 snapshotPath → snapshots[] → safetySnapshot', () => {
    expect(
      snapshotPaths({
        snapshotPath: '/a',
        snapshots: [{ path: '/b' }, { path: '/c' }],
        safetySnapshot: { path: '/d' },
      }),
    ).toEqual(['/a', '/b', '/c', '/d']);
  });
});

// ── isRestoreList ─────────────────────────────────────────────
describe('isRestoreList', () => {
  it('有 snapshots 字段 → 列表结果', () => {
    expect(isRestoreList({ store: '/s', snapshots: [] })).toBe(true);
  });

  it('无 snapshots(还原运行结果) → false', () => {
    const runResult = {
      restored: true as const,
      target: '/t',
      snapshot: { path: '/p', label: 'l', createdAt: '2026-01-01T00:00:00Z' },
      safetySnapshot: { path: '/p2', label: 'l2', createdAt: '2026-01-01T00:00:00Z' },
    };
    expect(isRestoreList(runResult)).toBe(false);
  });
});

// ── verdictLabel / severityLabel ──────────────────────────────
describe('verdictLabel', () => {
  let t: Awaited<ReturnType<typeof createI18nForLanguage>>['t'];
  beforeEach(async () => {
    const i18n = await createI18nForLanguage('en');
    t = i18n.t.bind(i18n);
  });

  it('SAFE → "Safe"', () => {
    expect(verdictLabel('SAFE', t)).toBe('Safe');
  });

  it('REVIEW → "Worth a look"', () => {
    expect(verdictLabel('REVIEW', t)).toBe('Worth a look');
  });

  it('DANGER → "Danger"', () => {
    expect(verdictLabel('DANGER', t)).toBe('Danger');
  });
});

describe('severityLabel', () => {
  let t: Awaited<ReturnType<typeof createI18nForLanguage>>['t'];
  beforeEach(async () => {
    const i18n = await createI18nForLanguage('en');
    t = i18n.t.bind(i18n);
  });

  it.each(['critical', 'high', 'medium', 'low'] as const)('%s 有对应标签', (sev) => {
    const label = severityLabel(sev, t);
    expect(label).toBeTruthy();
    expect(typeof label).toBe('string');
  });
});

// ── doctorKindLabel / driftTone / doctorHint ──────────────────
describe('doctorKindLabel', () => {
  let t: Awaited<ReturnType<typeof createI18nForLanguage>>['t'];
  beforeEach(async () => {
    const i18n = await createI18nForLanguage('en');
    t = i18n.t.bind(i18n);
  });

  it.each(['missing', 'content-drift', 'stale-lock', 'extra-locked'])('已知 kind(%s) → 对应标签', (kind) => {
    const label = doctorKindLabel(kind, t);
    expect(label).toBeTruthy();
    expect(label).not.toBe('unknown issue'); // 不应回退到 unknown
  });

  it('未知 kind → "unknown issue"', () => {
    expect(doctorKindLabel('future-kind-xyz', t)).toBe('unknown issue');
  });
});

describe('driftTone', () => {
  it('content-drift → danger(最高危,可能被篡改)', () => {
    expect(driftTone('content-drift')).toBe('danger');
  });

  it('其他类型 → warn', () => {
    expect(driftTone('missing')).toBe('warn');
    expect(driftTone('stale-lock')).toBe('warn');
    expect(driftTone('extra-locked')).toBe('warn');
  });
});

describe('doctorHint', () => {
  let t: Awaited<ReturnType<typeof createI18nForLanguage>>['t'];
  beforeEach(async () => {
    const i18n = await createI18nForLanguage('en');
    t = i18n.t.bind(i18n);
  });

  it.each(['missing', 'content-drift', 'stale-lock', 'extra-locked'])('已知 kind(%s) → 非空提示', (kind) => {
    const hint = doctorHint(kind, t);
    expect(hint).toBeTruthy();
  });

  it('未知 kind → 降级到 unknown 文本', () => {
    const hint = doctorHint('future-kind', t);
    expect(hint).toBeTruthy(); // 不应 throw
    expect(typeof hint).toBe('string');
  });
});

// ── mergeDeclaredSkills ───────────────────────────────────────
describe('mergeDeclaredSkills', () => {
  it('无声明时原样返回', () => {
    const data = makeDashboard({
      scan: { home: '/h', total: 1, skills: [makeSkill({ dirName: 'a', agents: ['claude-code'] })] },
    });
    const result = mergeDeclaredSkills(data);
    expect(result.scan.skills).toHaveLength(1);
    expect(result.scan.total).toBe(1);
  });

  it('声明补全 enabled 状态与 agents', () => {
    const skill = makeSkill({ dirName: 'foo', agents: ['claude-code'] });
    const declaration: DoctorDeclaration = {
      name: 'foo',
      source: '.skill-switch/skills.json',
      agents: ['claude-code', 'codex'],
      enabled: false,
      mode: 'copy',
    };
    const data = makeDashboard({
      scan: { home: '/h', total: 1, skills: [skill] },
      doctor: { ...emptyDoctor, declarations: [declaration] },
    });
    const result = mergeDeclaredSkills(data);
    const merged = result.scan.skills.find((s) => s.dirName === 'foo')!;
    expect(merged.enabled).toBe(false);
    expect(merged.agents).toContain('codex');
    expect(result.scan.total).toBe(1); // 技能已存在,不新增
  });

  it('声明里有磁盘上不存在的技能 → 追加', () => {
    const declaration: DoctorDeclaration = {
      name: 'ghost-skill',
      source: '.skill-switch/skills.json',
      agents: ['claude-code'],
      enabled: true,
      mode: 'copy',
    };
    const data = makeDashboard({
      scan: { home: '/h', total: 0, skills: [] },
      doctor: { ...emptyDoctor, declarations: [declaration] },
    });
    const result = mergeDeclaredSkills(data);
    expect(result.scan.skills).toHaveLength(1);
    expect(result.scan.skills[0]!.dirName).toBe('ghost-skill');
  });

  it('声明通过 skill.name(非 dirName)匹配', () => {
    // 技能目录名是 slug,但 frontmatter name 是 pretty-name,声明用 pretty-name
    const skill = makeSkill({ dirName: 'slug', agents: ['claude-code'], name: 'pretty-name' });
    const declaration: DoctorDeclaration = {
      name: 'pretty-name',
      source: '.skill-switch/skills.json',
      agents: ['claude-code', 'cursor'],
      enabled: true,
      mode: 'copy',
    };
    const data = makeDashboard({
      scan: { home: '/h', total: 1, skills: [skill] },
      doctor: { ...emptyDoctor, declarations: [declaration] },
    });
    const result = mergeDeclaredSkills(data);
    // 应匹配已有技能而不是新增,total 仍为 1
    expect(result.scan.skills).toHaveLength(1);
    expect(result.scan.skills[0]!.agents).toContain('cursor');
  });
});

// ── initialSectionStates ──────────────────────────────────────
describe('initialSectionStates', () => {
  it('所有区块初始状态为 idle', () => {
    expect(initialSectionStates.audit.status).toBe('idle');
    expect(initialSectionStates.stats.status).toBe('idle');
    expect(initialSectionStates.configAudit.status).toBe('idle');
  });
});

// ── createConfirmationDialogState ─────────────────────────────
describe('createConfirmationDialogState', () => {
  it('合并 request 字段,tone 缺省为 warn', () => {
    const close = vi.fn();
    const onConfirm = vi.fn();
    const state = createConfirmationDialogState(
      {
        title: 'Confirm',
        message: 'Are you sure?',
        confirmLabel: 'Yes',
        cancelLabel: 'No',
        onConfirm,
      },
      close,
    );
    expect(state.title).toBe('Confirm');
    expect(state.tone).toBe('warn'); // 缺省
    expect(state.details).toBeUndefined();
    expect(state.consequence).toBeUndefined();
  });

  it('tone=danger 透传', () => {
    const state = createConfirmationDialogState(
      { title: '', message: '', confirmLabel: '', cancelLabel: '', tone: 'danger', onConfirm: vi.fn() },
      vi.fn(),
    );
    expect(state.tone).toBe('danger');
  });

  it('空 details 数组 → state 里无 details 字段', () => {
    const state = createConfirmationDialogState(
      { title: '', message: '', confirmLabel: '', cancelLabel: '', details: [], onConfirm: vi.fn() },
      vi.fn(),
    );
    expect(state.details).toBeUndefined();
  });

  it('非空 details 数组 → 透传', () => {
    const state = createConfirmationDialogState(
      { title: '', message: '', confirmLabel: '', cancelLabel: '', details: ['step 1', 'step 2'], onConfirm: vi.fn() },
      vi.fn(),
    );
    expect(state.details).toEqual(['step 1', 'step 2']);
  });

  it('onConfirm 先 close 再调用 request.onConfirm', async () => {
    const calls: string[] = [];
    const close = vi.fn(() => { calls.push('close'); });
    const onConfirm = vi.fn(() => { calls.push('confirm'); });
    const state = createConfirmationDialogState(
      { title: '', message: '', confirmLabel: '', cancelLabel: '', onConfirm },
      close,
    );
    await state.onConfirm();
    expect(calls).toEqual(['close', 'confirm']);
  });

  it('onCancel 关闭对话框', async () => {
    const close = vi.fn();
    const state = createConfirmationDialogState(
      { title: '', message: '', confirmLabel: '', cancelLabel: '', onConfirm: vi.fn() },
      close,
    );
    await state.onCancel();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

// ── readStoredAdvanced / readStoredOnboarded ──────────────────
describe('readStoredAdvanced / readStoredOnboarded', () => {
  it('window 未定义(SSR/node)→ 返回 false(不抛)', () => {
    // 在 vitest/node 环境下 window 未定义,确认安全降级
    expect(readStoredAdvanced()).toBe(false);
    expect(readStoredOnboarded()).toBe(false);
  });
});

// ── advancedStorageKey / onboardedStorageKey 稳定性 ───────────
describe('storage keys 稳定性', () => {
  it('advancedStorageKey 是固定字符串(改动会破坏用户 localStorage)', () => {
    expect(advancedStorageKey).toBe('skill-switch-advanced');
  });

  it('onboardedStorageKey 是固定字符串', () => {
    expect(onboardedStorageKey).toBe('skill-switch-onboarded');
  });
});
