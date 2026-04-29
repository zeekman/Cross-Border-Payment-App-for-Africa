import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';

const BACKEND_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000';

/**
 * Hook to stream real-time payment events via Socket.IO (backed by Horizon streaming).
 * Falls back gracefully if the socket cannot connect.
 *
 * @param {string} publicKey - The account public key to monitor
 * @param {Function} onPayment - Callback when a payment:received event fires
 * @returns {{ isConnected: boolean, error: string|null }}
const HORIZON_URL = process.env.REACT_APP_STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

/**
 * Hook to stream real-time payment notifications from Stellar Horizon.
 * Tracks the last seen cursor so reconnections resume from where they left off.
 *
 * @param {string} publicKey - The account public key to monitor
 * @param {Function} onPayment - Callback when a new payment is detected
 * @returns {{ isConnected: boolean, isReconnecting: boolean, error: string|null, reconnect: Function }}
 */
export function usePaymentStream(publicKey, onPayment) {
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [error, setError] = useState(null);
  const socketRef = useRef(null);
  const onPaymentRef = useRef(onPayment);

  const streamRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  // Persist the last seen payment paging_token so we can resume on reconnect
  const lastCursorRef = useRef('now');
  const onPaymentRef = useRef(onPayment);

  // Keep callback ref fresh without triggering reconnects
  useEffect(() => { onPaymentRef.current = onPayment; }, [onPayment]);

  const clearReconnectTimer = () => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  };

  // Keep callback ref fresh without re-connecting
  useEffect(() => {
    onPaymentRef.current = onPayment;
  }, [onPayment]);

  const getToken = useCallback(() => {
    return localStorage.getItem('token') || sessionStorage.getItem('token') || null;
  }, []);

  useEffect(() => {
    if (!publicKey) return;

    const token = getToken();
    if (!token) return;

    const socket = io(BACKEND_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    });
    // Close any existing stream before opening a new one
    if (streamRef.current) {
      streamRef.current();
      streamRef.current = null;
    }

    try {
      const server = new StellarSdk.Horizon.Server(HORIZON_URL);

      streamRef.current = server
        .payments()
        .forAccount(publicKey)
        .cursor(lastCursorRef.current)
        .stream({
          onmessage: (payment) => {
            // Advance cursor so a reconnect resumes after this payment
            if (payment.paging_token) {
              lastCursorRef.current = payment.paging_token;
            }

            reconnectAttemptsRef.current = 0;
            setIsConnected(true);
            setIsReconnecting(false);
            setError(null);

            if (onPaymentRef.current) {
              onPaymentRef.current({
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
            console.warn('Payment stream disconnected:', err?.message || err);
            setIsConnected(false);

            const attempt = reconnectAttemptsRef.current;
            if (attempt < MAX_RECONNECT_ATTEMPTS) {
              const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
              reconnectAttemptsRef.current += 1;
              setIsReconnecting(true);
              setError(`Stream disconnected. Reconnecting in ${Math.round(delay / 1000)}s… (attempt ${attempt + 1})`);
              reconnectTimeoutRef.current = setTimeout(connect, delay);
            } else {
              setIsReconnecting(false);
              setError('Stream disconnected. Max reconnect attempts reached.');
            }
          },
          onclose: () => {
            setIsConnected(false);
          },
        });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      setIsReconnecting(false);
      setError(null);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('connect_error', (err) => {
      setError(err.message);
      setIsConnected(false);
    });

    socket.on('payment:received', (data) => {
      if (data.to === publicKey && onPaymentRef.current) {
        onPaymentRef.current(data);
      }
    });

    socket.on('payment:confirmed', (data) => {
      if (data.account === publicKey && onPaymentRef.current) {
        onPaymentRef.current({ ...data, type: 'confirmed' });
      }
    });

    } catch (err) {
      console.error('Failed to open payment stream:', err);
      setIsConnected(false);
      setError(err.message || 'Failed to connect');
    }
  }, [publicKey]);

  const disconnect = useCallback(() => {
    clearReconnectTimer();
    if (streamRef.current) {
      streamRef.current();
      streamRef.current = null;
    }
    setIsConnected(false);
    setIsReconnecting(false);
  }, []);

  const reconnect = useCallback(() => {
    clearReconnectTimer();
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect]);

  // Connect / reconnect when publicKey changes
  useEffect(() => {
    if (publicKey) {
      lastCursorRef.current = 'now';
      reconnectAttemptsRef.current = 0;
      connect();
    }
    return disconnect;
  }, [publicKey, connect, disconnect]);

  // Resume stream when the browser comes back online
  useEffect(() => {
    const handleOnline = () => { if (publicKey && !isConnected) reconnect(); };
    const handleOffline = () => { setIsConnected(false); };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [publicKey, getToken]);

  return { isConnected, error };
  return { isConnected, isReconnecting, error, reconnect, disconnect };
}

export default usePaymentStream;
