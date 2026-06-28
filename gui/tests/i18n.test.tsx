import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { DashboardShell } from '../src/App';
import { createI18nForLanguage, supportedLanguages } from '../src/i18n';
import { loadDashboardData } from '../src/data/fixtures';
import {
  CommandCancelledError,
  CommandTimeoutError,
  InvalidJsonError,
  NoJsonOutputError,
  localizedErrorDetail,
} from '../src/data/errors';

// 任一中文字符(防止英文/日文/西语模式下泄漏硬编码中文错误文案)。
const CJK = /[一-鿿]/;

const localeDir = join(import.meta.dirname, '..', 'src', 'locales');

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [prefix];
  }

  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

describe('gui i18n', () => {
  it('keeps locale key sets identical', () => {
    const [baseLanguage, ...otherLanguages] = supportedLanguages;
    const base = JSON.parse(readFileSync(join(localeDir, `${baseLanguage}.json`), 'utf8')) as unknown;
    const baseKeys = flattenKeys(base).sort();

    expect(baseKeys).not.toContain('skills.actions.adopt');
    expect(baseKeys).not.toContain('operations.confirm.adopt');
    expect(baseKeys).not.toContain('operations.notice.adopted');

    for (const language of otherLanguages) {
      const locale = JSON.parse(readFileSync(join(localeDir, `${language}.json`), 'utf8')) as unknown;
      expect(flattenKeys(locale).sort(), language).toEqual(baseKeys);
    }
  });

  it.each(supportedLanguages)('renders the dashboard in %s', async (language) => {
    const data = await loadDashboardData();
    const i18n = await createI18nForLanguage(language);

    const html = renderToString(
      <I18nextProvider i18n={i18n}>
        <DashboardShell data={data} onRefresh={async () => {}} />
      </I18nextProvider>,
    );

    expect(html).toContain(i18n.t('header.title'));
    expect(html).toContain(i18n.t('header.advanced'));
    expect(html).toContain(i18n.t('operations.title'));
    expect(html).not.toContain(i18n.t('overview.controlSurface.title'));
    expect(html).not.toContain('scan --json');
    if (language !== 'en') {
      expect(html).not.toContain('Governance Console');
    }
  });

  // 结构化命令错误经 localizedErrorDetail → t('errors.*') 渲染:
  // 验证四种错误在每种语言下都被翻译且正确插值,英文模式下不残留中文。
  it.each(supportedLanguages)('localizes command errors with no leaked Chinese in %s', async (language) => {
    const i18n = await createI18nForLanguage(language);
    const t = i18n.t.bind(i18n);

    const timeout = localizedErrorDetail(new CommandTimeoutError('install', 300_000), t);
    expect(timeout).toContain('install'); // label 插值
    expect(timeout).toContain('300000'); // timeoutMs 插值

    const cancelled = localizedErrorDetail(new CommandCancelledError('sync'), t);
    expect(cancelled).toContain('sync');

    const noJson = localizedErrorDetail(new NoJsonOutputError('scan', 'permission denied'), t);
    expect(noJson).toContain('scan');
    expect(noJson).toContain('permission denied'); // stderr 摘要插值

    const invalid = localizedErrorDetail(
      new InvalidJsonError('audit', 'Unexpected token', 'garbage', ''),
      t,
    );
    expect(invalid).toContain('audit');
    expect(invalid).toContain('Unexpected token'); // 解析错误原因插值

    // 没有命中 key 时 i18next 会回落到 raw key("errors.xxx") —— 确保四条都真的翻译了。
    for (const detail of [timeout, cancelled, noJson, invalid]) {
      expect(detail).not.toContain('errors.');
    }

    if (language === 'en') {
      for (const detail of [timeout, cancelled, noJson, invalid]) {
        expect(detail, detail).not.toMatch(CJK);
      }
    }

    if (language === 'zh-CN') {
      // 中文模式仍应是中文(回归保护:别把简体也改没了)
      expect(timeout).toMatch(CJK);
    }
  });
});
