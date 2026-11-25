import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ImportContactsModal from './ImportContactsModal';
import api from '../utils/api';

jest.mock('../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (opts ? `${key} ${JSON.stringify(opts)}` : key) }),
}));

const csv = () => new File(['name,wallet_address\n'], 'contacts.csv', { type: 'text/csv' });

afterEach(() => jest.clearAllMocks());

test('downloads the template from /contacts/import/template', async () => {
  window.URL.createObjectURL = jest.fn(() => 'blob:x');
  window.URL.revokeObjectURL = jest.fn();
  api.get.mockResolvedValue({ data: 'csv' });
  render(<ImportContactsModal isOpen onClose={jest.fn()} />);
  await userEvent.click(screen.getByText('contacts_import.download_template'));
  expect(api.get).toHaveBeenCalledWith('/contacts/import/template', { responseType: 'blob' });
});

test('uploads to /contacts/import, shows real counts and row errors, and notifies the caller', async () => {
  api.post.mockResolvedValue({
    data: { imported: 2, skipped_duplicates: 1, failed: 1, errors: [{ row: 4, error: 'Invalid address' }] },
  });
  const onImported = jest.fn();
  const { container } = render(<ImportContactsModal isOpen onClose={jest.fn()} onImported={onImported} />);
  await userEvent.upload(container.ownerDocument.querySelector('input[type="file"]'), csv());
  await userEvent.click(screen.getByText('contacts_import.upload'));

  await waitFor(() => expect(onImported).toHaveBeenCalled());
  expect(api.post).toHaveBeenCalledWith('/contacts/import', expect.any(FormData), expect.any(Object));
  expect(screen.getByText('contacts_import.imported {"count":2}')).toBeInTheDocument();
  expect(screen.getByText('contacts_import.skipped {"count":1}')).toBeInTheDocument();
  expect(screen.getByText('contacts_import.failed {"count":1}')).toBeInTheDocument();
  expect(screen.getByText('contacts_import.row_error {"row":4,"error":"Invalid address"}')).toBeInTheDocument();
});

test('is an accessible dialog that closes on Escape', () => {
  const onClose = jest.fn();
  render(<ImportContactsModal isOpen onClose={onClose} />);
  const dialog = screen.getByRole('dialog', { name: 'contacts_import.title' });
  expect(screen.getAllByRole('button', { name: 'common.close' }).length).toBeGreaterThan(0);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(onClose).toHaveBeenCalled();
});

test('rejects files over 5 MB client-side', async () => {
  render(<ImportContactsModal isOpen onClose={jest.fn()} />);
  const big = new File(['x'], 'big.csv', { type: 'text/csv' });
  Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 });
  await userEvent.upload(document.querySelector('input[type="file"]'), big);
  expect(screen.getByRole('alert')).toHaveTextContent('contacts_import.file_too_large');
});
