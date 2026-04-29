const { enqueue } = require('../utils/txQueue');

describe('txQueue', () => {
  test('serializes concurrent tasks for the same wallet', async () => {
    const order = [];
    const wallet = 'WALLET_A';

    const t1 = enqueue(wallet, async () => {
      await new Promise(r => setTimeout(r, 20));
      order.push(1);
    });
    const t2 = enqueue(wallet, async () => {
      order.push(2);
    });

    await Promise.all([t1, t2]);
    expect(order).toEqual([1, 2]);
  });

  test('runs tasks for different wallets in parallel', async () => {
    const order = [];

    const t1 = enqueue('WALLET_A', async () => {
      await new Promise(r => setTimeout(r, 30));
      order.push('A');
    });
    const t2 = enqueue('WALLET_B', async () => {
      order.push('B');
    });

    await Promise.all([t1, t2]);
    // B should finish before A because A has a delay
    expect(order).toEqual(['B', 'A']);
  });

  test('rejects with ETIMEDOUT when task exceeds the queue timeout', async () => {
    // Use a short timeout via env so the test doesn't take 30s
    process.env.TX_QUEUE_TIMEOUT_MS = '50';
    jest.resetModules();
    const { enqueue: enqueueShort } = require('../utils/txQueue');

    const promise = enqueueShort('WALLET_TIMEOUT', () => new Promise(() => {})); // never resolves

    await expect(promise).rejects.toMatchObject({ code: 'ETIMEDOUT' });

    delete process.env.TX_QUEUE_TIMEOUT_MS;
    jest.resetModules();
  }, 3000);

  test('returns the resolved value of the task', async () => {
    const result = await enqueue('WALLET_C', async () => 42);
    expect(result).toBe(42);
  });

  test('propagates task errors without blocking subsequent tasks', async () => {
    const wallet = 'WALLET_D';

    const t1 = enqueue(wallet, async () => { throw new Error('boom'); });
    const t2 = enqueue(wallet, async () => 'ok');

    await expect(t1).rejects.toThrow('boom');
    await expect(t2).resolves.toBe('ok');
  });
});
