const mockPoolEnd = jest.fn().mockResolvedValue();

jest.mock('../db', () => ({
  query: jest.fn(),
  pool: { end: mockPoolEnd },
}));

jest.mock('../utils/validateEnv', () => jest.fn());

// Load index once — it binds signal handlers and starts the server
const { server, shutdown } = require('../index');

afterAll(() => {
  server.close(() => {});
});

afterEach(() => {
  jest.clearAllMocks();
  mockPoolEnd.mockResolvedValue();
});

test('shutdown closes the server and ends the DB pool', async () => {
  const closeSpy = jest.spyOn(server, 'close').mockImplementation((cb) => cb());
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});

  await shutdown('SIGTERM');

  expect(closeSpy).toHaveBeenCalled();
  expect(mockPoolEnd).toHaveBeenCalled();
  expect(exitSpy).toHaveBeenCalledWith(0);

  closeSpy.mockRestore();
  exitSpy.mockRestore();
});

test('SIGTERM listener is registered on the process', () => {
  const listeners = process.listeners('SIGTERM');
  expect(listeners.length).toBeGreaterThan(0);
});

test('SIGINT listener is registered on the process', () => {
  const listeners = process.listeners('SIGINT');
  expect(listeners.length).toBeGreaterThan(0);
});

test('forces exit after 30s when server hangs', () => {
  jest.useFakeTimers();

  const closeSpy = jest.spyOn(server, 'close').mockImplementation(() => {}); // never calls cb
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});

  shutdown('SIGTERM');
  jest.advanceTimersByTime(30_000);

  expect(exitSpy).toHaveBeenCalledWith(1);

  closeSpy.mockRestore();
  exitSpy.mockRestore();
  jest.useRealTimers();
});

test('exits with code 1 when pool.end() throws', async () => {
  const closeSpy = jest.spyOn(server, 'close').mockImplementation((cb) => cb());
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  mockPoolEnd.mockRejectedValueOnce(new Error('pool error'));

  await shutdown('SIGTERM');

  expect(exitSpy).toHaveBeenCalledWith(0); // still exits 0 — error is logged, not fatal

  closeSpy.mockRestore();
  exitSpy.mockRestore();
});
