import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import '../../i18n';
import api from '../../utils/api';
import SupportTicket from '../SupportTicket';
import SupportTickets from '../../components/profile/SupportTickets';
import RequestMoney from '../RequestMoney';
import toast from 'react-hot-toast';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('react-hot-toast', () => ({ __esModule: true, default: { success: jest.fn(), error: jest.fn() } }));
jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { wallet_address: 'GABC' } }), tokenStore: { get: () => null } }));

const ticket = { id: 7, type: 'other', status: 'open', description: 'Help me', created_at: '2026-01-01', attachments: [{ id: 'a', filename: 'f.png', original_name: 'proof.png' }] };

beforeEach(() => {
  jest.clearAllMocks();
  global.URL.createObjectURL = jest.fn(() => 'blob:x');
  global.URL.revokeObjectURL = jest.fn();
  api.post.mockResolvedValue({ data: {} });
  api.get.mockImplementation((url) => Promise.resolve({ data: {
    '/support/tickets': { tickets: [] },
    '/support/tickets/7': { ticket, messages: [{ id: 1, author_role: 'admin', body: 'Hello there', created_at: '2026-01-02' }] },
    '/payments/history': { transactions: [{ id: 'uuid-1', amount: '5', asset: 'XLM', recipient_wallet: 'GXYZ', created_at: '2026-01-01' }] },
  }[url] || {} }));
});

const page = () => render(
  <MemoryRouter initialEntries={['/support/7']}><Routes><Route path="/support/:id" element={<SupportTicket />} /></Routes></MemoryRouter>,
);

test('reads and replies to a ticket', async () => {
  page();
  expect(await screen.findByText('Hello there')).toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText('Write a reply…'), { target: { value: 'Thanks' } });
  fireEvent.click(screen.getByText('Send reply'));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/support/tickets/7/messages', expect.any(FormData)));
  expect(api.post.mock.calls[0][1].get('body')).toBe('Thanks');
  await waitFor(() => expect(screen.getByPlaceholderText('Write a reply…')).toHaveValue(''));
});

test('opens attachments through the authenticated endpoint', async () => {
  const win = { location: {}, close: jest.fn() };
  window.open = jest.fn(() => win);
  page();
  fireEvent.click(await screen.findByText('proof.png'));
  await waitFor(() => expect(win.location.href).toBe('blob:x'));
  expect(api.get).toHaveBeenCalledWith('/support/tickets/7/attachments/f.png', { responseType: 'blob' });
});

test('shows an error state', async () => {
  api.get.mockRejectedValue(new Error('x'));
  page();
  expect(await screen.findByRole('alert')).toBeInTheDocument();
});

test('form pre-fills the transaction, rejects bad files and posts FormData', async () => {
  const { container } = render(<MemoryRouter initialEntries={['/profile?support=new&tx=uuid-1&type=failed_deducted']}><SupportTickets /></MemoryRouter>);
  await screen.findByText(/5 XLM/);
  expect(screen.getByLabelText('Transaction')).toHaveValue('uuid-1');
  const input = container.querySelector('input[type=file]');
  fireEvent.change(input, { target: { files: [new File(['x'], 'a.exe', { type: 'application/x-msdownload' })] } });
  expect(toast.error).toHaveBeenCalledWith('Only PNG, JPEG and PDF files are allowed');
  const big = new File(['x'], 'b.png', { type: 'image/png' });
  Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 });
  fireEvent.change(input, { target: { files: [big] } });
  expect(toast.error).toHaveBeenCalledWith('Each file must be 5 MB or smaller');
  fireEvent.change(input, { target: { files: [new File(['x'], 'ok.png', { type: 'image/png' })] } });
  fireEvent.change(screen.getByPlaceholderText('Describe your issue...'), { target: { value: 'desc' } });
  fireEvent.submit(container.querySelector('form'));
  await waitFor(() => expect(api.post).toHaveBeenCalled());
  const body = api.post.mock.calls[0][1];
  expect(body.get('transaction_id')).toBe('uuid-1');
  expect(body.getAll('attachments')).toHaveLength(1);
  await waitFor(() => expect(toast.success).toHaveBeenCalled());
});

test('RequestMoney shows a real sentence for an invalid amount', async () => {
  const { container } = render(<MemoryRouter><RequestMoney /></MemoryRouter>);
  fireEvent.submit(container.querySelector('form'));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Please enter a valid amount'));
});
