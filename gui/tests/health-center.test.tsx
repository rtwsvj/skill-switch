// v0.3 D1:健康中心 —— doctor 三方对账可视化(按漂移类型分组 + 本地化提示 + legacy 告警)。
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { HealthCenter } from '../src/App';
import { createI18nForLanguage } from '../src/i18n';
import type { DoctorReport } from '../src/data';

const cleanDoctor: DoctorReport = {
  findings: [],
  clean: true,
  checked: { declared: 3, locked: 3 },
  declarations: [],
};

async function render(doctor: DoctorReport, lockOk: boolean) {
  const i18n = await createI18nForLanguage('en');
  const html = renderToString(
    <I18nextProvider i18n={i18n}>
      <HealthCenter doctor={doctor} lockOk={lockOk} />
    </I18nextProvider>,
  );
  return { html, i18n };
}

describe('D1 HealthCenter', () => {
  it('shows the all-good state when there is no drift and no legacy names', async () => {
    const { html, i18n } = await render(cleanDoctor, true);
    expect(html).toContain(i18n.t('doctor.allGood'));
    expect(html).toContain(i18n.t('status.clean'));
  });

  it('groups drift findings by kind with a localized hint and the affected skill', async () => {
    const doctor: DoctorReport = {
      ...cleanDoctor,
      clean: false,
      findings: [
        { kind: 'content-drift', agent: 'claude-code', name: 'edited-skill', detail: '中文 detail 不应泄漏' },
        { kind: 'missing', agent: 'codex', name: 'gone-skill', detail: '中文 detail 不应泄漏' },
      ],
    };
    const { html, i18n } = await render(doctor, true);
    // 分组标签 + 本地化提示(不是 CLI 的中文 detail);用无撇号片段避开 HTML 转义。
    expect(html).toContain(i18n.t('doctor.kind.content-drift'));
    expect(html).toContain('On-disk content no longer matches the lock');
    expect(html).toContain('claude-code / edited-skill');
    expect(html).toContain('codex / gone-skill');
    expect(html).not.toContain('detail 不应泄漏'); // 不暴露 CLI 中文 detail
    expect(html).toContain(i18n.t('status.drift'));
  });

  it('surfaces legacy (non-canonical) names as a migration warning', async () => {
    const doctor: DoctorReport = { ...cleanDoctor, clean: true, legacyNames: ['legacy name'] };
    const { html, i18n } = await render(doctor, true);
    expect(html).toContain(i18n.t('doctor.legacy.title'));
    expect(html).toContain('legacy name');
  });
});
