// 覆盖透明度摘要:stats 扫描了多少 / 跳过多少 / 解析失败 / 截断。
import { describe, expect, it } from 'vitest';
import { auditCoverageSummary, coverageSummary } from '../src/App';
import { createI18nForLanguage } from '../src/i18n';
import type { AuditReport, StatsReport } from '../src/data';

const base: StatsReport = { scannedFiles: 0, invocations: 0, usage: [], zombies: [] };

async function t() {
  const i18n = await createI18nForLanguage('en');
  return i18n.t.bind(i18n);
}

describe('coverageSummary', () => {
  it('returns empty when nothing was scanned and nothing truncated (e.g. unloaded stats)', async () => {
    expect(coverageSummary(base, await t())).toBe('');
  });

  it('summarizes scanned files only', async () => {
    expect(coverageSummary({ ...base, scannedFiles: 128 }, await t())).toBe('Scanned 128 chat-log files');
  });

  it('appends skipped / parse-error / truncated parts when present', async () => {
    const text = coverageSummary(
      { ...base, scannedFiles: 128, skippedFiles: 3, parseErrors: 1, truncated: true },
      await t(),
    );
    expect(text).toContain('Scanned 128 chat-log files');
    expect(text).toContain('skipped 3');
    expect(text).toContain('1 could not be parsed');
    expect(text).toContain('truncated');
    expect(text.split(' · ').length).toBe(4);
  });

  it('omits zero-valued optional parts', async () => {
    const text = coverageSummary({ ...base, scannedFiles: 10, skippedFiles: 0, parseErrors: 0 }, await t());
    expect(text).toBe('Scanned 10 chat-log files');
  });
});

const auditBase: AuditReport = { path: '/x', findings: [], score: 100, verdict: 'SAFE' };

describe('auditCoverageSummary', () => {
  it('returns empty when no report carries coverage', async () => {
    expect(auditCoverageSummary([auditBase, auditBase], await t())).toBe('');
  });

  it('aggregates scanned + skipped (skippedFiles + tooLargeFiles) across reports', async () => {
    const reports: AuditReport[] = [
      { ...auditBase, coverage: { scannedFiles: 4, skippedFiles: 0, tooLargeFiles: 0, readErrors: 0, truncated: false } },
      { ...auditBase, coverage: { scannedFiles: 7, skippedFiles: 1, tooLargeFiles: 1, readErrors: 2, truncated: true } },
    ];
    const text = auditCoverageSummary(reports, await t());
    expect(text).toContain('scanned 11 files'); // 4 + 7
    expect(text).toContain('skipped 2'); // (0+0) + (1+1)
    expect(text).toContain('2 could not be read');
    expect(text).toContain('truncated');
  });
});
