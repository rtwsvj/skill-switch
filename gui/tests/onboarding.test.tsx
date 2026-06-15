// v0.3 A1:首启引导卡 —— 未引导时在总览顶部显示欢迎 + 三句指引。
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { DashboardShell } from '../src/App';
import { createI18nForLanguage } from '../src/i18n';
import { loadDashboardData } from '../src/data/fixtures';

describe('A1 onboarding card', () => {
  it('shows the welcome card + guidance points on the overview for a fresh user (no localStorage in SSR)', async () => {
    const i18n = await createI18nForLanguage('en');
    const data = await loadDashboardData();
    const html = renderToString(
      <I18nextProvider i18n={i18n}>
        <DashboardShell data={data} initialScreen="overview" onRefresh={async () => {}} />
      </I18nextProvider>,
    );
    expect(html).toContain(i18n.t('onboarding.title'));
    expect(html).toContain(i18n.t('onboarding.dismiss'));
    const points = i18n.t('onboarding.points', { returnObjects: true }) as string[];
    expect(Array.isArray(points)).toBe(true);
    expect(points.length).toBe(3);
    // 至少第一条指引文案出现在卡片里。
    expect(html).toContain(points[0]);
  });
});
