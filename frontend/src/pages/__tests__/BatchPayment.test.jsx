import React from 'react';
import { screen, act } from '@testing-library/react';
import { renderWithProviders } from '../../testUtils';
import BatchPayment from '../BatchPayment';
import api from '../../utils/api';

jest.mock('../../utils/api');
jest.mock('react-hot-toast', () => ({ __esModule: true, default: { success: jest.fn(), error: jest.fn() } }));
jest.mock('../../hooks/useStepUp', () => ({
  __esModule: true,
  default: () => ({ requestStepUp: jest.fn(), stepUpModal: null }),
}));

describe('BatchPayment', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Regression: the page referenced useRef/useEffect without importing them and an
  // undefined `batchId`, so it threw a ReferenceError as soon as it rendered.
  test('renders without throwing', () => {
    expect(() => renderWithProviders(<BatchPayment />)).not.toThrow();
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
  });

  test('makes no status requests before a batch with a batch_id has been submitted', async () => {
    renderWithProviders(<BatchPayment />);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });

    expect(api.get).not.toHaveBeenCalled();
  });
});
