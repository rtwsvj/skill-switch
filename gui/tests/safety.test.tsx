// F-C1 安全中心:audit 摘要 + bypass 留痕展示。
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { DashboardShell } from '../src/App';
import { createI18nForLanguage } from '../src/i18n';
import { loadDashboardData } from '../src/data/fixtures';
import type { BypassRecord, DashboardData } from '../src/data';

function withBypass(data: DashboardData, bypass: BypassRecord): DashboardData {
  const next = JSON.parse(JSON.stringify(data)) as DashboardData;
  next.doctor.bypasses = [bypass];
  return next;
}

describe('F-C1 safety center', () => {
  it('shows the bypass ledger (name, reason, badge) on the audit screen', async () => {
    const i18n = await createI18nForLanguage('en');
    const data = withBypass(await loadDashboardData(), {
      name: 'risky-internal-skill',
      agent: 'claude-code',
      auditBypassed: true,
      bypassedAt: '2026-06-16T00:00:00.000Z',
      bypassReason: 'trusted internal source',
      score: 40,
      bypassedFindings: [{ ruleId: 'shell-exec', severity: 'critical' }],
      cliVersion: '0.1.0',
    });

    const html = renderToString(
      <I18nextProvider i18n={i18n}>
        <DashboardShell data={data} initialScreen="audit" onRefresh={async () => {}} />
      </I18nextProvider>,
    );

    expect(html).toContain('risky-internal-skill');
    expect(html).toContain('trusted internal source');
    expect(html).toContain(i18n.t('safety.bypass.badge'));
    expect(html).toContain(i18n.t('safety.summary.blocked'));
  });

  it('does not render the bypass panel when there are no bypasses', async () => {
    const i18n = await createI18nForLanguage('en');
    const data = await loadDashboardData(); // 默认无 bypasses
    const html = renderToString(
      <I18nextProvider i18n={i18n}>
        <DashboardShell data={data} initialScreen="audit" onRefresh={async () => {}} />
      </I18nextProvider>,
    );
    expect(html).not.toContain(i18n.t('safety.bypass.title'));
  });
});
