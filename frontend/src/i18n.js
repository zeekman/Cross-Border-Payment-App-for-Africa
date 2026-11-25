import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en/translation.json';
import sw from './locales/sw/translation.json';
import fr from './locales/fr/translation.json';
import ha from './locales/ha/translation.json';
import yo from './locales/yo/translation.json';

export const SUPPORTED_LANGUAGES = ['en', 'sw', 'fr', 'ha', 'yo'];

export function detectBrowserLanguage() {
  if (typeof navigator === 'undefined') return null;
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const l of langs) {
    const base = String(l || '').toLowerCase().split('-')[0];
    if (SUPPORTED_LANGUAGES.includes(base)) return base;
  }
  return null;
}

const savedLanguage = typeof window !== 'undefined' ? localStorage.getItem('afripay_lang') : null;
const initialLanguage = savedLanguage || detectBrowserLanguage() || 'en';

const RTL_LOCALES = ['ar'];

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    sw: { translation: sw },
    fr: { translation: fr },
    ha: { translation: ha },
    yo: { translation: yo }
  },
  lng: initialLanguage,
  fallbackLng: 'en',
  interpolation: { escapeValue: false }
});

i18n.on('languageChanged', (lng) => {
  document.documentElement.dir = RTL_LOCALES.includes(lng) ? 'rtl' : 'ltr';
  document.documentElement.lang = lng;
});

if (typeof document !== 'undefined') {
  document.documentElement.lang = i18n.language;
  document.documentElement.dir = RTL_LOCALES.includes(i18n.language) ? 'rtl' : 'ltr';
}

export default i18n;
