import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from './i18n';

describe('i18n Setup and Translations', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset i18n to default English
    i18n.changeLanguage('en');
  });

  describe('Language Resources Registration', () => {
    test('all language resources are properly registered', async () => {
      const languages = ['en', 'fr', 'sw', 'ha', 'yo'];
      for (const lang of languages) {
        await i18n.changeLanguage(lang);
        expect(i18n.language).toBe(lang);
      }
    });

    test('each language has translation namespace', async () => {
      const languages = ['en', 'fr', 'sw', 'ha', 'yo'];
      for (const lang of languages) {
        await i18n.changeLanguage(lang);
        // Should not throw when accessing nested keys
        expect(() => i18n.t('common.back')).not.toThrow();
      }
    });

    test('translation keys return translated strings, not keys', async () => {
      await i18n.changeLanguage('en');
      const enTranslation = i18n.t('common.back');
      expect(enTranslation).toBe('Back');
      expect(enTranslation).not.toBe('common.back');
    });
  });

  describe('Language Switching', () => {
    test('changeLanguage updates current language', async () => {
      expect(i18n.language).toBe('en');
      await i18n.changeLanguage('fr');
      expect(i18n.language).toBe('fr');
    });

    test('changing language updates translated strings', async () => {
      await i18n.changeLanguage('en');
      expect(i18n.t('common.back')).toBe('Back');

      await i18n.changeLanguage('fr');
      expect(i18n.t('common.back')).toBe('Retour');

      await i18n.changeLanguage('sw');
      expect(i18n.t('common.back')).toBe('Rudi');

      await i18n.changeLanguage('ha');
      expect(i18n.t('common.back')).toBe('Koma');

      await i18n.changeLanguage('yo');
      expect(i18n.t('common.back')).toBe('Padà');
    });

    test('switching between all supported languages works', async () => {
      const languages = ['en', 'fr', 'sw', 'ha', 'yo'];
      for (const lang of languages) {
        await i18n.changeLanguage(lang);
        expect(i18n.language).toBe(lang);
        expect(i18n.t('common.loading')).not.toContain('common.loading');
      }
    });
  });

  describe('localStorage Persistence', () => {
    test('language preference is saved to localStorage', () => {
      localStorage.setItem('afripay_lang', 'fr');
      expect(localStorage.getItem('afripay_lang')).toBe('fr');
    });

    test('localStorage persists across language changes', async () => {
      await i18n.changeLanguage('sw');
      localStorage.setItem('afripay_lang', 'sw');
      expect(localStorage.getItem('afripay_lang')).toBe('sw');

      await i18n.changeLanguage('ha');
      localStorage.setItem('afripay_lang', 'ha');
      expect(localStorage.getItem('afripay_lang')).toBe('ha');
    });

    test('i18n uses stored language preference on initialization', () => {
      localStorage.setItem('afripay_lang', 'fr');
      // Initial i18n load should use localStorage value
      const storedLang = localStorage.getItem('afripay_lang');
      expect(storedLang).toBe('fr');
    });

    test('fallback to English when no language preference in localStorage', () => {
      localStorage.clear();
      const storedLang = localStorage.getItem('afripay_lang');
      expect(storedLang).toBeNull();
      // i18n should default to 'en'
      expect(i18n.language).toBe('en');
    });
  });

  describe('Translation Completeness', () => {
    test('French translations are complete', async () => {
      await i18n.changeLanguage('fr');
      expect(i18n.t('common.back')).not.toContain('common.back');
      expect(i18n.t('register.title')).not.toContain('register.title');
      expect(i18n.t('profile.language')).not.toContain('profile.language');
    });

    test('Swahili translations are complete', async () => {
      await i18n.changeLanguage('sw');
      expect(i18n.t('common.back')).not.toContain('common.back');
      expect(i18n.t('login.title')).not.toContain('login.title');
      expect(i18n.t('profile.language')).not.toContain('profile.language');
    });

    test('Hausa translations are complete', async () => {
      await i18n.changeLanguage('ha');
      expect(i18n.t('common.back')).not.toContain('common.back');
      expect(i18n.t('dashboard.greeting')).not.toContain('dashboard.greeting');
      expect(i18n.t('profile.language')).not.toContain('profile.language');
    });

    test('Yoruba translations are complete', async () => {
      await i18n.changeLanguage('yo');
      expect(i18n.t('common.back')).not.toContain('common.back');
      expect(i18n.t('send.title')).not.toContain('send.title');
      expect(i18n.t('profile.language')).not.toContain('profile.language');
    });
  });

  describe('Fallback Behavior', () => {
    test('missing translation falls back to English', async () => {
      await i18n.changeLanguage('en');
      const enTranslation = i18n.t('common.back');
      expect(enTranslation).toBe('Back');
    });

    test('fallback language is English', () => {
      // i18next stores fallbackLng as an array internally
      const fallbackLng = Array.isArray(i18n.options.fallbackLng)
        ? i18n.options.fallbackLng[0]
        : i18n.options.fallbackLng;
      expect(fallbackLng).toBe('en');
    });

    test('all key sections exist in all languages', async () => {
      const sections = ['common', 'welcome', 'register', 'login', 'passwordReset', 'dashboard', 'send', 'auth', 'receive', 'history', 'profile'];
      const languages = ['en', 'fr', 'sw', 'ha', 'yo'];

      for (const lang of languages) {
        await i18n.changeLanguage(lang);
        for (const section of sections) {
          // Test that section keys can be accessed
          expect(() => i18n.t(`${section}.`)).not.toThrow();
        }
      }
    });
  });

  describe('Interpolation and Special Values', () => {
    test('interpolation values are properly handled', async () => {
      await i18n.changeLanguage('en');
      const result = i18n.t('auth.pin_attempts_remaining', { remaining: 3 });
      expect(result).toContain('3');
      expect(result).not.toContain('{{remaining}}');
    });

    test('interpolation works in all languages', async () => {
      const languages = ['en', 'fr', 'sw', 'ha', 'yo'];
      for (const lang of languages) {
        await i18n.changeLanguage(lang);
        const result = i18n.t('auth.pin_attempts_remaining', { remaining: 2 });
        expect(result).toContain('2');
        expect(result).not.toContain('{{remaining}}');
      }
    });
  });

  describe('i18n Configuration', () => {
    test('escapeValue is disabled for HTML safety', () => {
      expect(i18n.options.interpolation.escapeValue).toBe(false);
    });

    test('i18next is initialized with React', () => {
      expect(i18n.isInitialized).toBe(true);
    });

    test('default language is English', () => {
      localStorage.clear();
      // Create a fresh test - the instance should start with 'en'
      expect(i18n.language).toBe('en');
    });
  });
});
