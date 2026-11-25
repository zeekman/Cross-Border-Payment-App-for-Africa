import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import Webhooks from '../Webhooks';
import api from '../../utils/api';

jest.mock('../../utils/api');
jest.mock('react-hot-toast', () => ({ success: jest.fn(), error: jest.fn() }));

describe('Webhooks secret display', () => {
  const webhook = {
    id: 'webhook-1',
    url: 'https://example.com/hook',
    events: ['payment.sent'],
    active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    secret_masked: 'abcd****',
  };

  beforeEach(() => {
    api.get.mockResolvedValue({ data: { webhooks: [webhook] } });
  });

  test('masks the secret after a page revisit', async () => {
    const firstRender = render(<Webhooks />);
    await waitFor(() => expect(screen.getByText('abcd****')).toBeInTheDocument());
    expect(screen.queryByText(/^[a-f0-9]{64}$/)).not.toBeInTheDocument();

    firstRender.unmount();
    render(<Webhooks />);
    await waitFor(() => expect(screen.getByText('abcd****')).toBeInTheDocument());
    expect(screen.queryByText(/^[a-f0-9]{64}$/)).not.toBeInTheDocument();
  });

  test('does not render a plaintext secret returned by a list response', async () => {
    api.get.mockResolvedValue({
      data: {
        webhooks: [{ ...webhook, secret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }],
      },
    });

    render(<Webhooks />);

    await waitFor(() => expect(screen.getByText('abcd****')).toBeInTheDocument());
    expect(screen.queryByText(/^[a-f0-9]{64}$/)).not.toBeInTheDocument();
  });
});
