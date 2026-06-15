// M0-5.6/A1:dashboard 装配对部分失败的容忍——一个区块失败不拖垮整体。
import { describe, expect, it } from 'vitest';
import { assembleDashboard, emptyStats, type DashboardParts } from '../src/data/dashboard';
import type { AuditReport, DoctorReport, LockVerifyReport, ScanReport, StatsReport } from '../src/data/types';

const scan: ScanReport = { home: '/h', total: 1, skills: [{ agents: ['claude-code'], relSkillsDir: '.claude/skills', dirName: 'a', dir: '/h/a', path: '/h/a/SKILL.md', name: 'a' }] };
const audit: AuditReport[] = [];
const doctor: DoctorReport = { findings: [], clean: true, checked: { declared: 1, locked: 1 }, declarations: [] };
const stats: StatsReport = { scannedFiles: 3, invocations: 5, usage: [], zombies: [] };
const lockVerify: LockVerifyReport = { ok: true, lockPath: '/h/.skill-switch/skills.lock.json', entries: [] };

const ok = <T,>(value: T): PromiseSettledResult<T> => ({ status: 'fulfilled', value });
const fail = (msg: string): PromiseSettledResult<never> => ({ status: 'rejected', reason: new Error(msg) });

function allOk(): DashboardParts {
  return { scan: ok(scan), audit: ok(audit), doctor: ok(doctor), stats: ok(stats), lockVerify: ok(lockVerify) };
}

describe('assembleDashboard', () => {
  it('passes through all sections and records no errors when everything loads', () => {
    const data = assembleDashboard(allOk(), 'tauri');
    expect(data.scan.total).toBe(1);
    expect(data.stats.invocations).toBe(5);
    expect(data.loadErrors).toBeUndefined();
    expect(data.source).toBe('tauri');
  });

  it('tolerates a failed stats section: keeps the rest, records the error, uses safe default', () => {
    const data = assembleDashboard({ ...allOk(), stats: fail('transcript parse blew up') }, 'tauri');
    expect(data.scan.total).toBe(1); // 其余区块完好
    expect(data.doctor.clean).toBe(true);
    expect(data.stats).toEqual(emptyStats); // 失败区块用安全默认值,不是 undefined
    expect(data.loadErrors).toEqual({ stats: 'transcript parse blew up' });
  });

  it('records every failed section and never throws', () => {
    const data = assembleDashboard(
      { scan: fail('a'), audit: fail('b'), doctor: ok(doctor), stats: fail('c'), lockVerify: ok(lockVerify) },
      'fixtures',
    );
    expect(Object.keys(data.loadErrors ?? {}).sort()).toEqual(['audit', 'scan', 'stats']);
    expect(data.doctor.clean).toBe(true); // 成功区块仍在
    expect(data.scan.skills).toEqual([]); // 失败区块安全默认
    expect(data.audit).toEqual([]);
  });
});
