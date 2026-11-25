import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import i18n from '../i18n';
import en from './en/translation.json';
import ha from './ha/translation.json';

// Issue #643: verify that switching to Hausa (ha) renders real Hausa strings
// — not silent English fallbacks — for key UI labels (≥10), following the
// Profile.i18n.test.jsx integration pattern.
const KEYS = [
  'common.back',
  'common.loading',
  'common.cancel',
  'common.continue',
  'common.share',
  'common.add',
  'common.see_all',
  'common.sign_out',
  'dashboard.send',
  'profile.title',
  'send.title',
];

const get = (obj, path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);

function Labels() {
  const { t } = useTranslation();
  return (
    <ul>
      {KEYS.map((k) => (
        <li key={k} data-testid={k}>
          {t(k)}
        </li>
      ))}
    </ul>
  );
}

describe('Hausa (ha) translation coverage', () => {
  afterAll(async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  test('covers at least 10 key UI labels', () => {
    expect(KEYS.length).toBeGreaterThanOrEqual(10);
  });

  test('renders Hausa strings (no English fallback) when locale is ha', async () => {
    await act(async () => {
      await i18n.changeLanguage('ha');
    });

    render(
      <I18nextProvider i18n={i18n}>
        <Labels />
      </I18nextProvider>
    );

    for (const key of KEYS) {
      const expected = get(ha, key);
      const node = screen.getByTestId(key);
      // Renders the documented Hausa string …
      expect(node).toHaveTextContent(expected);
      // … and never the English baseline (no silent fallback) or the raw key.
      expect(node.textContent).not.toBe(get(en, key));
      expect(node.textContent).not.toBe(key);
    }
  });
});
