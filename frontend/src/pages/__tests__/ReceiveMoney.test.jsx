import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ReceiveMoney from '../ReceiveMoney';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { username: 'alice', displayName: 'Alice Merchant' },
  }),
}));

vi.mock('../../services/api', () => ({
  getAccountInfo: vi.fn().mockResolvedValue({
    username: 'alice',
    displayName: 'Alice Merchant',
    address: 'GABCDEF1234567890',
  }),
}));

describe('ReceiveMoney print QR', () => {
  let printSpy;

  beforeEach(() => {
    printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
  });

  afterEach(() => {
    printSpy.mockRestore();
  });

  it('calls window.print when the Print button is clicked', async () => {
    render(
      <MemoryRouter>
        <ReceiveMoney />
      </MemoryRouter>
    );

    const printButton = await screen.findByRole('button', { name: /print/i });
    fireEvent.click(printButton);

    await waitFor(() => {
      expect(printSpy).toHaveBeenCalledTimes(1);
    });
  });
});
