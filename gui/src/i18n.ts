import i18n, { createInstance, type i18n as I18nInstance } from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import es from './locales/es.json';
import ja from './locales/ja.json';
import zhCN from './locales/zh-CN.json';

export const supportedLanguages = ['zh-CN', 'en', 'ja', 'es'] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

export const languageLabels: Record<SupportedLanguage, string> = {
  'zh-CN': '简体中文',
  en: 'English',
  ja: '日本語',
  es: 'Español',
};

const resources: Record<SupportedLanguage, { translation: object }> = {
  'zh-CN': { translation: zhCN },
  en: { translation: en },
  ja: { translation: ja },
  es: { translation: es },
};

const detection = {
  order: ['localStorage', 'navigator', 'htmlTag'],
  lookupLocalStorage: 'skill-switch-language',
  caches: ['localStorage'],
};

function normalizeLanguage(language: string): SupportedLanguage {
  if (supportedLanguages.includes(language as SupportedLanguage)) return language as SupportedLanguage;
  if (language.toLowerCase().startsWith('zh')) return 'zh-CN';
  const base = language.split('-')[0];
  if (supportedLanguages.includes(base as SupportedLanguage)) return base as SupportedLanguage;
  return 'en';
}

export async function createI18nForLanguage(language: SupportedLanguage): Promise<I18nInstance> {
  const instance = createInstance();
  await instance.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: 'en',
    supportedLngs: [...supportedLanguages],
    interpolation: { escapeValue: false },
  });
  return instance;
}

function initI18n() {
  if (i18n.isInitialized) return i18n;

  void i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources,
      fallbackLng: 'en',
      supportedLngs: [...supportedLanguages],
      detection,
      interpolation: { escapeValue: false },
    })
    .then(() => {
      void i18n.changeLanguage(normalizeLanguage(i18n.resolvedLanguage ?? i18n.language));
    });

  return i18n;
}

initI18n();

export default i18n;
