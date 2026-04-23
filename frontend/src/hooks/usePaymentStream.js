import { useState, useEffect, useRef, useCallback } from 'react';
import * as StellarSdk from '@stellar/stellar-sdk';

const HORIZON_URL = process.env.REACT_APP_STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const isTestnet = process.env.REACT_APP_STELLAR_NETWORK !== 'mainnet';
const networkPassphrase = isTestnet
  ? StellarSdk.Networks.TESTNET
  : StellarSdk.Networks.PUBLIC;

/**
 * Hook to stream real-time payment notifications from Stellar Horizon
 * @param {string} publicKey - The account public key to monitor
 * @param {Function} onPayment - Callback when a new payment is detected
 * @returns {Object} { isConnected, error, reconnect }
 */
export function usePaymentStream(publicKey, onPayment) {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState(null);
  const streamRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 5;
  const baseReconnectDelay = 1000; // 1 second

  const connect = useCallback(() => {
    if (!publicKey) return;

    try {
      const server = new StellarSdk.Horizon.Server(HORIZON_URL);
      
      // Close existing stream if any
      if (streamRef.current) {
        streamRef.current();
      }

      streamRef.current = server
        .payments()
        .forAccount(publicKey)
        .cursor('now')
        .stream({
          onmessage: (payment) => {
            // Reset reconnect attempts on successful message
            reconnectAttemptsRef.current = 0;
            setError(null);
            setIsConnected(true);
            
            // Call the callback with payment data
            if (onPayment) {
              onPayment({
                id: payment.id,
                type: payment.type,
                from: payment.from,
                to: payment.to,
                amount: payment.amount,
                asset: payment.asset_type === 'native' ? 'XLM' : payment.asset_code,
                createdAt: payment.created_at,
                transactionHash: payment.transaction_hash,
              });
            }
          },
          onerror: (err) => {
            console.error('Payment stream error:', err);
            setError(err.message || 'Stream error');
            setIsConnected(false);
            
            // Attempt to reconnect with exponential backoff
            if (reconnectAttemptsRef.current < maxReconnectAttempts) {
              const delay = baseReconnectDelay * Math.pow(2, reconnectAttemptsRef.current);
              reconnectAttemptsRef.current += 1;
              
              reconnectTimeoutRef.current = setTimeout(() => {
                connect();
              }, delay);
            }
          },
          onclose: () => {
            setIsConnected(false);
          }
        });

      setIsConnected(true);
      setError(null);
    } catch (err) {
      console.error('Failed to connect to payment stream:', err);
      setError(err.message || 'Failed to connect');
      setIsConnected(false);
    }
  }, [publicKey, onPayment]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    
    if (streamRef.current) {
      streamRef.current();
      streamRef.current = null;
    }
    
    setIsConnected(false);
  }, []);

  const reconnect = useCallback(() => {
    disconnect();
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect, disconnect]);

  // Connect on mount and when publicKey changes
  useEffect(() => {
    if (publicKey) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [publicKey, connect, disconnect]);

  // Handle network interruption
  useEffect(() => {
    const handleOnline = () => {
      if (publicKey && !isConnected) {
        reconnect();
      }
    };

    const handleOffline = () => {
      setIsConnected(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [publicKey, isConnected, reconnect]);

  return { isConnected, error, reconnect, disconnect };
}

export default usePaymentStream;
