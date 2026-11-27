import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../../i18n';
import api from '../../utils/api';
import toast from 'react-hot-toast';
import RequesterCard from '../RequesterCard';
import PINSetupModal from '../PINSetupModal';
import ContractStatusBanners from '../ContractStatusBanners';
import WebhookVerifyPanel from '../WebhookVerifyPanel';
import SaveMoney from '../../pages/SaveMoney';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('react-hot-toast', () => ({ __esModule: true, default: { error: jest.fn(), success: jest.fn() } }));
jest.mock('../../hooks/useStepUp', () => ({ __esModule: true, default: () => ({ requestStepUp: jest.fn(), stepUpModal: null }) }));
jest.mock('../../config/network', () => ({ CONTRACT_IDS: { savingsVault: 'CVAULT' }, RELEASE_NOTES_URL: 'https://example.com' }));

beforeEach(() => localStorage.clear());

test('requester card shows identity and warns for non-contacts', () => {
  const requester = { display_name: 'Ada', kyc_verified: true, member_since: '2024-03-10' };
  const { rerender } = render(<RequesterCard requester={requester} isContact={false} />);
  expect(screen.getByText('Ada')).toBeInTheDocument();
  expect(screen.getByText('Verified')).toBeInTheDocument();
  expect(screen.getByText(/Member since/)).toBeInTheDocument();
  expect(screen.getByRole('note')).toBeInTheDocument();
  rerender(<RequesterCard requester={requester} isContact />);
  expect(screen.queryByRole('note')).toBeNull();
});

test('requester card reports expiry', () => {
  const onExpire = jest.fn();
  render(<RequesterCard expiresAt="2020-01-01" isContact onExpire={onExpire} />);
  expect(onExpire).toHaveBeenCalledTimes(1);
});

test('weak PIN disables Continue; server WEAK_PIN is inline', async () => {
  api.post.mockRejectedValue({ response: { data: { code: 'WEAK_PIN', reason: 'common' } } });
  render(<PINSetupModal isOpen onClose={() => {}} onSuccess={() => {}} />);
  const type = (v) => fireEvent.change(screen.getByPlaceholderText('●●●●'), { target: { value: v } });
  type('1234');
  expect(screen.getByRole('alert')).toHaveTextContent('Avoid sequences');
  expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  type('8305');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  type('8305');
  fireEvent.submit(screen.getByPlaceholderText('●●●●').closest('form'));
  expect(await screen.findByText('This PIN is too common')).toBeInTheDocument();
  expect(toast.error).not.toHaveBeenCalled();
});

test('pending upgrade shows ETA and dismisses per hash; normal state is hidden', () => {
  const view = (state) => <MemoryRouter><ContractStatusBanners states={{ savingsVault: state }} /></MemoryRouter>;
  const { rerender } = render(view({ paused: false }));
  expect(screen.queryByRole('status')).toBeNull();
  rerender(view({ pending_upgrade: { hash: 'a', eta: 1893499200 } }));
  expect(screen.getByRole('status')).toHaveTextContent('2030');
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('status')).toBeNull();
  rerender(view({ pending_upgrade: { hash: 'b', eta: 1893499200 } }));
  expect(screen.getByRole('status')).toBeInTheDocument();
});

test('paused contract shows banner and disables deposit', async () => {
  api.get.mockImplementation((url) => Promise.resolve({ data: url.startsWith('/contracts/') ? { paused: true } : {} }));
  render(<MemoryRouter><SaveMoney /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Savings deposits');
  fireEvent.change(document.querySelector('input[type="number"]'), { target: { value: '5' } });
  expect(document.querySelector('button[type="submit"]')).toBeDisabled();
});

test('webhook snippets switch and copy', async () => {
  const writeText = jest.fn().mockResolvedValue();
  Object.assign(navigator, { clipboard: { writeText } });
  render(<WebhookVerifyPanel />);
  for (const name of ['Node.js', 'Python', 'PHP']) {
    fireEvent.click(screen.getByRole('tab', { name }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy snippet' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('AFRIPAY_WEBHOOK_SECRET');
  }
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(3));
});
