/**
 * Tests for issue #242:
 * horizonWorker.js must reconnect with exponential backoff on stream error/close.
 *   - Starts at 1 s, caps at 60 s.
 *   - Logs attempt number and delay.
 *   - After 10 consecutive failures, logs logger.error and stops retrying.
 */
jest.mock('../src/db');
jest.mock('../src/controllers/notificationController', () => ({ sendPushToUser: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/utils/metrics', () => ({ wsConnections: { set: jest.fn() } }));

// Mock logger so we can assert on calls
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const logger = require('../src/utils/logger');
const {
  backoffDelay,
  _scheduleReconnect,
  MAX_RECONNECT_ATTEMPTS,
} = require('../src/services/horizonWorker');

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('#242 horizonWorker reconnection logic', () => {
  describe('backoffDelay', () => {
    test('returns at least 1000 ms on attempt 0', () => {
      for (let i = 0; i < 20; i++) {
        expect(backoffDelay(0)).toBeGreaterThanOrEqual(1000);
      }
    });

    test('never exceeds 60000 ms cap', () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        expect(backoffDelay(attempt)).toBeLessThanOrEqual(60000);
      }
    });

    test('ceiling grows with attempt number (up to cap)', () => {
      // At attempt 0 ceiling = min(60000, 1000*1) = 1000
      // At attempt 6 ceiling = min(60000, 1000*64) = 60000 (capped)
      // Just verify delay at attempt 6 can reach higher values than attempt 0
      const samples0 = Array.from({ length: 50 }, () => backoffDelay(0));
      const samples6 = Array.from({ length: 50 }, () => backoffDelay(6));
      expect(Math.max(...samples6)).toBeGreaterThanOrEqual(Math.max(...samples0));
    });
  });

  describe('MAX_RECONNECT_ATTEMPTS', () => {
    test('is 10', () => {
      expect(MAX_RECONNECT_ATTEMPTS).toBe(10);
    });
  });

  describe('_scheduleReconnect', () => {
    test('logs attempt number and delay on each reconnect', () => {
      _scheduleReconnect('user1', 'GPUBKEY', 'now', 1);
      expect(logger.info).toHaveBeenCalledWith(
        'Horizon stream: scheduling reconnect',
        expect.objectContaining({ attempt: 1, publicKey: 'GPUBKEY' }),
      );
      const call = logger.info.mock.calls.find(([msg]) => msg === 'Horizon stream: scheduling reconnect');
      expect(call[1].delayMs).toBeGreaterThanOrEqual(1000);
      expect(call[1].delayMs).toBeLessThanOrEqual(60000);
    });

    test('logs logger.error and stops after MAX_RECONNECT_ATTEMPTS consecutive failures', () => {
      _scheduleReconnect('user1', 'GPUBKEY', 'now', MAX_RECONNECT_ATTEMPTS + 1);

      expect(logger.error).toHaveBeenCalledWith(
        'Horizon stream: max reconnection attempts reached, giving up',
        expect.objectContaining({ publicKey: 'GPUBKEY', maxAttempts: MAX_RECONNECT_ATTEMPTS }),
      );
      // No setTimeout should have been scheduled
      expect(jest.getTimerCount()).toBe(0);
    });

    test('does not log error before the limit is reached', () => {
      _scheduleReconnect('user1', 'GPUBKEY', 'now', MAX_RECONNECT_ATTEMPTS);
      expect(logger.error).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(1); // one setTimeout scheduled
    });

    test('schedules a setTimeout for reconnection', () => {
      _scheduleReconnect('user1', 'GPUBKEY', 'now', 3);
      expect(jest.getTimerCount()).toBe(1);
    });

    test('attempt 1 through MAX are all scheduled; attempt MAX+1 is not', () => {
      for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
        jest.clearAllTimers();
        logger.error.mockClear();
        _scheduleReconnect('user1', 'GPUBKEY', 'now', attempt);
        expect(jest.getTimerCount()).toBe(1);
        expect(logger.error).not.toHaveBeenCalled();
      }

      jest.clearAllTimers();
      _scheduleReconnect('user1', 'GPUBKEY', 'now', MAX_RECONNECT_ATTEMPTS + 1);
      expect(jest.getTimerCount()).toBe(0);
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
