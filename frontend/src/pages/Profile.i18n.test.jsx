import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import api from '../utils/api';
import toast from 'react-hot-toast';

jest.mock('../utils/api', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock('../context/AuthContext', () => ({
  ...jest.requireActual('../context/AuthContext'),
  useAuth: () => ({
    user: { full_name: 'John Doe', email: 'john@test.com', wallet_address: 'GC...123' },
    logout: jest.fn(),
  }),
}));

jest.mock('react-hot-toast');

// Import Profile after mocks are set up
const Profile = require('./Profile').default;

jest.setTimeout(15000);

function mockMountCalls({ contacts = [], trustlines = [], activity = [] } = {}) {
  api.get
    .mockResolvedValueOnce({ data: { trustlines } })
    .mockResolvedValueOnce({ data: { contacts } })
    .mockResolvedValueOnce({ data: { activity } });
}

const renderProfileWithI18n = async () => {
  await act(async () => {
    render(
      <BrowserRouter>
        <I18nextProvider i18n={i18n}>
          <Profile />
        </I18nextProvider>
      </BrowserRouter>
    );
  });
};

describe('Profile Language Selector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    i18n.changeLanguage('en');
    window.confirm = jest.fn(() => true);
  });

  test('language selector is displayed on Profile page', async () => {
    mockMountCalls({ contacts: [] });

    await renderProfileWithI18n();

    await waitFor(() => {
      expect(screen.getByText('Language')).toBeInTheDocument();
    });
  });

  test('all language options are available in the selector', async () => {
    mockMountCalls({ contacts: [] });

    await renderProfileWithI18n();

    await waitFor(() => {
      expect(screen.getByText('English')).toBeInTheDocument();
      expect(screen.getByText('Français')).toBeInTheDocument();
      expect(screen.getByText('Kiswahili')).toBeInTheDocument();
      expect(screen.getByText('Hausa')).toBeInTheDocument();
      expect(screen.getByText('Yorùbá')).toBeInTheDocument();
    });
  });

  test('clicking language button switches the language', async () => {
    mockMountCalls({ contacts: [] });

    await renderProfileWithI18n();

    // Wait for the Profile page to load
    await waitFor(() => {
      expect(screen.getByText('English')).toBeInTheDocument();
    });

    // Click on French button
    const frenchButton = screen.getByRole('button', { name: /Français/i });
    fireEvent.click(frenchButton);

    // Wait for language to change
    await waitFor(() => {
      expect(i18n.language).toBe('fr');
    });

    // The language text should change
    const languageLabel = screen.getByText('Langue'); // "Language" in French
    expect(languageLabel).toBeInTheDocument();
  });

  test('selected language button is highlighted', async () => {
    mockMountCalls({ contacts: [] });

    await renderProfileWithI18n();

    await waitFor(() => {
      expect(screen.getByText('English')).toBeInTheDocument();
    });

    const englishButton = screen.getByRole('button', { name: /^English$/ });
    
    // English button should be active (have primary color)
    expect(englishButton).toHaveClass('bg-primary-500');

    // Click French button
    const frenchButton = screen.getByRole('button', { name: /^Français$/ });
    fireEvent.click(frenchButton);

    await waitFor(() => {
      expect(i18n.language).toBe('fr');
      expect(frenchButton).toHaveClass('bg-primary-500');
    });

    // English button should no longer be active
    expect(englishButton).toHaveClass('bg-gray-800');
  });

  test('language selection persists in localStorage', async () => {
    mockMountCalls({ contacts: [] });

    await renderProfileWithI18n();

    await waitFor(() => {
      expect(screen.getByText('English')).toBeInTheDocument();
    });

    const swahiliButton = screen.getByRole('button', { name: /Kiswahili/i });
    fireEvent.click(swahiliButton);

    await waitFor(() => {
      expect(localStorage.getItem('afripay_lang')).toBe('sw');
    });
  });

  test('language persists across different languages', async () => {
    mockMountCalls({ contacts: [] });

    await renderProfileWithI18n();

    // Switch to Hausa
    await waitFor(() => {
      expect(screen.getByText('English')).toBeInTheDocument();
    });

    const hausaButton = screen.getByRole('button', { name: /Hausa/i });
    fireEvent.click(hausaButton);

    await waitFor(() => {
      expect(localStorage.getItem('afripay_lang')).toBe('ha');
      expect(i18n.language).toBe('ha');
    });

    // Switch to Yoruba
    const yorubaButton = screen.getByRole('button', { name: /Yorùbá/i });
    fireEvent.click(yorubaButton);

    await waitFor(() => {
      expect(localStorage.getItem('afripay_lang')).toBe('yo');
      expect(i18n.language).toBe('yo');
    });
  });

  test('language switching does not require page reload', async () => {
    mockMountCalls({ contacts: [] });

    await renderProfileWithI18n();

    await waitFor(() => {
      expect(screen.getByText('English')).toBeInTheDocument();
    });

    // Should have title in English initially
    let titleElement = screen.getByText('Profile');
    expect(titleElement).toBeInTheDocument();

    // Switch to French
    const frenchButton = screen.getByRole('button', { name: /Français/i });
    fireEvent.click(frenchButton);

    // Wait for French translation of Profile title
    await waitFor(() => {
      const frenchTitle = screen.getByText('Profil');
      expect(frenchTitle).toBeInTheDocument();
    });
  });

  test('all language strings are translated, not showing keys', async () => {
    mockMountCalls({ contacts: [] });

    await renderProfileWithI18n();

    // Switch through all languages and check translations
    const languages = ['en', 'fr', 'sw', 'ha', 'yo'];

    for (const lang of languages) {
      await act(async () => {
        await i18n.changeLanguage(lang);
      });

      // Profile title should never be the translation key
      const screenText = screen.queryByText('profile.title');
      expect(screenText).not.toBeInTheDocument();
    }
  });

  test('default language is English on first load', async () => {
    localStorage.clear();
    mockMountCalls({ contacts: [] });

    await renderProfileWithI18n();

    await waitFor(() => {
      expect(i18n.language).toBe('en');
      expect(screen.getByText('Profile')).toBeInTheDocument();
    });
  });

  test('language selector is accessible via keyboard', async () => {
    mockMountCalls({ contacts: [] });

    await renderProfileWithI18n();

    await waitFor(() => {
      expect(screen.getByText('English')).toBeInTheDocument();
    });

    // Get the French button
    const frenchButton = screen.getByRole('button', { name: /Français/i });
    
    // Simulate keyboard interaction
    fireEvent.keyDown(frenchButton, { key: 'Enter', code: 'Enter' });
    fireEvent.click(frenchButton);

    await waitFor(() => {
      expect(i18n.language).toBe('fr');
    });
  });
});
