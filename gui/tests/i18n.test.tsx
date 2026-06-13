import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { DashboardShell } from '../src/App';
import { createI18nForLanguage, supportedLanguages } from '../src/i18n';
import { loadDashboardData } from '../src/data/fixtures';

const localeDir = join(process.cwd(), 'gui/src/locales');

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
        <DashboardShell data={data} />
      </I18nextProvider>,
    );

    expect(html).toContain(i18n.t('header.title'));
    expect(html).toContain(i18n.t('overview.controlSurface.title'));
    if (language !== 'en') {
      expect(html).not.toContain('Governance Console');
    }
  });
});
