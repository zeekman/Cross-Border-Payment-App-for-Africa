import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import api from '../../../utils/api';
import ChangeEmail from '../ChangeEmail';

jest.mock('../../../utils/api', () => ({
  __esModule: true,
  default: {
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    delete: jest.fn(() => Promise.resolve({ data: {} })),
  },
}));
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ user: { wallet_address: 'GABC', totp_enabled: false }, updateUser: jest.fn(), logout: jest.fn() }),
}));
jest.mock('../../../context/ConfirmContext', () => ({ useConfirm: () => jest.fn(() => Promise.resolve(true)) }));
jest.mock('react-hot-toast', () => ({ __esModule: true, default: { success: jest.fn(), error: jest.fn() } }));

beforeEach(() => {
  api.get.mockResolvedValue({ data: {} });
  api.post.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
});

test('ChangeEmail renders its section', async () => {
  const { container } = render(
    <MemoryRouter>
      <ChangeEmail />
    </MemoryRouter>
  );
  await waitFor(() => expect(container.firstChild).not.toBeNull());
});
