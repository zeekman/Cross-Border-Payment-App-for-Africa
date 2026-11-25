const { waitForSorobanTx, TxTimeoutError } = require('../config/soroban');

describe('waitForSorobanTx', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('gives up with TxTimeoutError when the RPC always returns NOT_FOUND', async () => {
    const rpc = { getTransaction: jest.fn().mockResolvedValue({ status: 'NOT_FOUND' }) };
    const promise = waitForSorobanTx(rpc, { status: 'PENDING', hash: 'abc' }, { timeoutMs: 10000 });
    const assertion = expect(promise).rejects.toMatchObject({ name: 'TxTimeoutError', code: 'TX_TIMEOUT', status: 504 });
    await jest.advanceTimersByTimeAsync(11000);
    await assertion;
    expect(rpc.getTransaction).toHaveBeenCalled();
    expect(TxTimeoutError).toBeDefined();
  });

  it('resolves once the transaction succeeds', async () => {
    const rpc = {
      getTransaction: jest.fn()
        .mockResolvedValueOnce({ status: 'NOT_FOUND' })
        .mockResolvedValueOnce({ status: 'SUCCESS' }),
    };
    const promise = waitForSorobanTx(rpc, { status: 'DUPLICATE', hash: 'abc' });
    await jest.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toEqual({ status: 'SUCCESS' });
  });

  it('throws on TRY_AGAIN_LATER without polling', async () => {
    const rpc = { getTransaction: jest.fn() };
    await expect(waitForSorobanTx(rpc, { status: 'TRY_AGAIN_LATER', hash: 'abc' }))
      .rejects.toMatchObject({ status: 503 });
    expect(rpc.getTransaction).not.toHaveBeenCalled();
  });
});
