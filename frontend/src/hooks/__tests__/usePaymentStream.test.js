import { renderHook, waitFor, act } from '@testing-library/react';
import { usePaymentStream } from '../usePaymentStream';
import * as StellarSdk from '@stellar/stellar-sdk';

// Mock Stellar SDK
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: {
    Server: jest.fn()
  },
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC: 'Public Global Stellar Network ; September 2015'
  }
}));

describe('usePaymentStream', () => {
  let mockServer;
  let mockStream;
  let mockOnPayment;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockStream = jest.fn();
    mockServer = {
      payments: jest.fn().mockReturnValue({
        forAccount: jest.fn().mockReturnValue({
          cursor: jest.fn().mockReturnValue({
            stream: mockStream
          })
        })
      })
    };
    
    StellarSdk.Horizon.Server.mockImplementation(() => mockServer);
    mockOnPayment = jest.fn();
  });

  test('returns initial state', () => {
    const { result } = renderHook(() => 
      usePaymentStream('GTEST123', mockOnPayment)
    );
    
    expect(result.current.isConnected).toBe(false);
    expect(result.current.error).toBe(null);
  });

  test('connects to payment stream when publicKey is provided', async () => {
    const { result } = renderHook(() => 
      usePaymentStream('GTEST123', mockOnPayment)
    );
    
    await waitFor(() => {
      expect(mockServer.payments).toHaveBeenCalled();
    });
    
    expect(mockServer.payments().forAccount).toHaveBeenCalledWith('GTEST123');
    expect(mockServer.payments().forAccount().cursor).toHaveBeenCalledWith('now');
  });

  test('calls onPayment callback when payment is received', async () => {
    const mockPayment = {
      id: '123',
      type: 'payment',
      from: 'GSENDER',
      to: 'GTEST123',
      amount: '10.5',
      asset_type: 'native',
      created_at: '2024-01-01T00:00:00Z',
      transaction_hash: 'abc123'
    };

    const { result } = renderHook(() => 
      usePaymentStream('GTEST123', mockOnPayment)
    );
    
    // Simulate receiving a payment
    const streamCallback = mockStream.mock.calls[0][0].onmessage;
    streamCallback(mockPayment);
    
    await waitFor(() => {
      expect(mockOnPayment).toHaveBeenCalledWith({
        id: '123',
        type: 'payment',
        from: 'GSENDER',
        to: 'GTEST123',
        amount: '10.5',
        asset: 'XLM',
        createdAt: '2024-01-01T00:00:00Z',
        transactionHash: 'abc123'
      });
    });
  });

  test('handles stream errors', async () => {
    const { result } = renderHook(() => 
      usePaymentStream('GTEST123', mockOnPayment)
    );
    
    // Simulate stream error
    const errorCallback = mockStream.mock.calls[0][0].onerror;
    errorCallback(new Error('Stream error'));
    
    await waitFor(() => {
      expect(result.current.error).toBe('Stream error');
    });
  });

  test('reconnects on error with exponential backoff', async () => {
    jest.useFakeTimers();
    
    const { result } = renderHook(() => 
      usePaymentStream('GTEST123', mockOnPayment)
    );
    
    // Simulate stream error
    const errorCallback = mockStream.mock.calls[0][0].onerror;
    errorCallback(new Error('Stream error'));
    
    // Fast-forward timers
    await act(async () => {
      jest.advanceTimersByTime(1000); // 1 second
    });
    
    // Should attempt to reconnect
    expect(mockServer.payments).toHaveBeenCalledTimes(2);
    
    jest.useRealTimers();
  });

  test('disconnects when publicKey is null', async () => {
    const { result, rerender } = renderHook(() => 
      usePaymentStream(null, mockOnPayment)
    );
    
    await waitFor(() => {
      expect(result.current.isConnected).toBe(false);
    });
    
    expect(mockServer.payments).not.toHaveBeenCalled();
  });

  test('reconnects when publicKey changes', async () => {
    const { result, rerender } = renderHook(({ publicKey }) => 
      usePaymentStream(publicKey, mockOnPayment),
      { initialProps: { publicKey: 'GTEST123' } }
    );
    
    await waitFor(() => {
      expect(mockServer.payments).toHaveBeenCalled();
    });
    
    // Change publicKey
    rerender({ publicKey: 'GTEST456' });
    
    await waitFor(() => {
      expect(mockServer.payments().forAccount).toHaveBeenCalledWith('GTEST456');
    });
  });

  test('handles non-native assets correctly', async () => {
    const mockPayment = {
      id: '123',
      type: 'payment',
      from: 'GSENDER',
      to: 'GTEST123',
      amount: '100',
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      created_at: '2024-01-01T00:00:00Z',
      transaction_hash: 'abc123'
    };

    const { result } = renderHook(() => 
      usePaymentStream('GTEST123', mockOnPayment)
    );
    
    // Simulate receiving a payment
    const streamCallback = mockStream.mock.calls[0][0].onmessage;
    streamCallback(mockPayment);
    
    await waitFor(() => {
      expect(mockOnPayment).toHaveBeenCalledWith(expect.objectContaining({
        asset: 'USDC'
      }));
    });
  });

  test('reconnect function manually reconnects', async () => {
    const { result } = renderHook(() => 
      usePaymentStream('GTEST123', mockOnPayment)
    );
    
    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });
    
    // Manually reconnect
    act(() => {
      result.current.reconnect();
    });
    
    await waitFor(() => {
      expect(mockServer.payments).toHaveBeenCalledTimes(2);
    });
  });

  test('disconnect function stops the stream', async () => {
    const { result } = renderHook(() => 
      usePaymentStream('GTEST123', mockOnPayment)
    );
    
    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });
    
    // Disconnect
    act(() => {
      result.current.disconnect();
    });
    
    await waitFor(() => {
      expect(result.current.isConnected).toBe(false);
    });
  });
});
