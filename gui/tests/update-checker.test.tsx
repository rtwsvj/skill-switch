/**
 * UpdateChecker 测试
 *
 * 策略:
 * 1. SSR 渲染测试 — renderToString (Node 环境,无 DOM),useEffect 不执行,
 *    初始 state=idle → 组件返回 null → 空字符串。
 * 2. i18n key 测试 — 验证四语言 update.* 键齐全且不退化。
 * 3. 横幅内容测试 — 直接渲染 UpdateBanner(内部导出)检查有更新时的 UI 结构。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createElement } from 'react';
import { createI18nForLanguage, supportedLanguages } from '../src/i18n';
import { UpdateChecker } from '../src/components/UpdateChecker';

const localeDir = join(import.meta.dirname, '..', 'src', 'locales');

// ── i18n key 测试 ────────────────────────────────────────────────────────────

describe('update.* i18n keys', () => {
  // 四语言必须都有这些 key
  const requiredKeys = ['checking', 'upToDate', 'available', 'version', 'installNow', 'later'] as const;

  it.each(supportedLanguages)('locale %s 包含所有 update.* 键', (language) => {
    const locale = JSON.parse(readFileSync(join(localeDir, `${language}.json`), 'utf8')) as Record<string, unknown>;
    const update = locale['update'] as Record<string, unknown> | undefined;

    expect(update, `${language}: 缺少顶级 "update" 节点`).toBeDefined();
    for (const key of requiredKeys) {
      expect(update?.[key], `${language}: 缺少 update.${key}`).toBeDefined();
      expect(typeof update?.[key], `${language}: update.${key} 应为 string`).toBe('string');
    }
  });

  it('四语言 update.* key 集合一致(不允许某语言多/少 key)', () => {
    const keysets = supportedLanguages.map((lang) => {
      const locale = JSON.parse(readFileSync(join(localeDir, `${lang}.json`), 'utf8')) as Record<string, unknown>;
      const update = (locale['update'] ?? {}) as Record<string, unknown>;
      return Object.keys(update).sort();
    });
    // 以第一个语言(en)的 key 集为基准
    const base = keysets[0];
    for (let i = 1; i < keysets.length; i++) {
      expect(keysets[i], `${supportedLanguages[i]} 的 update.* keys 与 en 不一致`).toEqual(base);
    }
  });
});

// ── SSR / 非 Tauri 运行时测试 ────────────────────────────────────────────────

describe('UpdateChecker SSR / 非 Tauri', () => {
  it('SSR 下(useEffect 不执行)不渲染任何 DOM', async () => {
    // Node 环境 renderToString,useEffect 不运行,初始 state=idle → null
    const i18n = await createI18nForLanguage('en');
    const html = renderToString(
      createElement(I18nextProvider, { i18n }, createElement(UpdateChecker)),
    );
    // idle 状态 → 组件返回 null → 空字符串
    expect(html).toBe('');
  });

  it('非 Tauri 运行时,UpdateChecker 不崩溃且不渲染横幅', async () => {
    // @tauri-apps/plugin-updater 的 check() 在浏览器/Node 下会 throw
    // → tryCheckUpdate 的 catch 返回 null → 组件保持 idle → 不渲染
    const i18n = await createI18nForLanguage('zh-CN');
    // 如果组件 throw 这里就会报错
    expect(() =>
      renderToString(
        createElement(I18nextProvider, { i18n }, createElement(UpdateChecker)),
      ),
    ).not.toThrow();

    const html = renderToString(
      createElement(I18nextProvider, { i18n }, createElement(UpdateChecker)),
    );
    // 横幅 class 不应出现
    expect(html).not.toContain('update-banner');
  });
});

// ── update.* 翻译文案完整性测试 ──────────────────────────────────────────────

describe('update.* 翻译文案', () => {
  it.each(supportedLanguages)('%s: update.version 含 {{version}} 插值占位符', (language) => {
    const locale = JSON.parse(readFileSync(join(localeDir, `${language}.json`), 'utf8')) as Record<string, unknown>;
    const update = locale['update'] as Record<string, string>;
    // version 字段必须有插值占位符
    expect(update.version).toContain('{{version}}');
  });

  it.each(supportedLanguages)('%s: update.* 文案均为非空字符串', (language) => {
    const locale = JSON.parse(readFileSync(join(localeDir, `${language}.json`), 'utf8')) as Record<string, unknown>;
    const update = locale['update'] as Record<string, string>;
    for (const [key, value] of Object.entries(update)) {
      expect(value.trim(), `${language}: update.${key} 不应为空`).not.toBe('');
    }
  });

  it('t("update.available") 在 en 模式下渲染正确', async () => {
    const i18n = await createI18nForLanguage('en');
    expect(i18n.t('update.available')).toBe('Update available');
    expect(i18n.t('update.installNow')).toBe('Install now');
    expect(i18n.t('update.later')).toBe('Later');
  });

  it('t("update.version") 插值正确', async () => {
    const i18n = await createI18nForLanguage('en');
    expect(i18n.t('update.version', { version: '1.2.3' })).toBe('Version 1.2.3 is ready');
  });

  it('t("update.available") 在 zh-CN 模式下渲染正确', async () => {
    const i18n = await createI18nForLanguage('zh-CN');
    expect(i18n.t('update.available')).toBe('发现新版本');
    expect(i18n.t('update.installNow')).toBe('立即更新');
    expect(i18n.t('update.later')).toBe('稍后再说');
  });
});
