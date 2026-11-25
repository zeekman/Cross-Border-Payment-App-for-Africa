'use strict';

jest.mock('../services/anchor', () => ({
  initiateDeposit: jest.fn(),
  initiateWithdrawal: jest.fn(),
  getTransactionStatus: jest.fn(),
}));
jest.mock('../db');
jest.mock('../utils/logger');

const { initiateDeposit, initiateWithdrawal, getTransactionStatus } = require('../services/anchor');
const db = require('../db');

let deposit, withdraw, status;

function freshApp(env) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('anchorController')) delete require.cache[k];
  }
  process.env.NODE_ENV = env;
  const ctrl = require('../controllers/anchorController');
  deposit = ctrl.deposit;
  withdraw = ctrl.withdraw;
  status = ctrl.status;
}

function makeReq(headers = {}, body = {}, params = {}) {
  return {
    headers: { ...headers },
    body: { asset: 'USDC', ...body },
    params,
    user: { userId: 'user-1' },
  };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [{ public_key: 'GABC…' }] });
  initiateDeposit.mockResolvedValue({ url: 'https://anchor.example.com/deposit', id: 'dep-1' });
  initiateWithdrawal.mockResolvedValue({ url: 'https://anchor.example.com/withdraw', id: 'wd-1' });
  getTransactionStatus.mockResolvedValue({ status: 'completed' });
});

describe('extractSep10Jwt — production', () => {
  beforeEach(() => freshApp('production'));

  test('deposit returns 400 when no X-Sep10-Token, even with Authorization header', async () => {
    const req = makeReq({ authorization: 'Bearer app-jwt-token' }, { amount: '100' });
    const res = makeRes();
    await deposit(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'X-Sep10-Token header is required' });
    expect(initiateDeposit).not.toHaveBeenCalled();
  });

  test('withdraw returns 400 when no X-Sep10-Token, even with Authorization header', async () => {
    const req = makeReq({ authorization: 'Bearer app-jwt-token' }, { amount: '50' });
    const res = makeRes();
    await withdraw(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'X-Sep10-Token header is required' });
    expect(initiateWithdrawal).not.toHaveBeenCalled();
  });

  test('status returns 400 when no X-Sep10-Token', async () => {
    const req = makeReq({ authorization: 'Bearer app-jwt-token' }, {}, { id: 'tx-1' });
    const res = makeRes();
    await status(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'X-Sep10-Token header is required' });
    expect(getTransactionStatus).not.toHaveBeenCalled();
  });

  test('deposit forwards dedicated X-Sep10-Token when present', async () => {
    const req = makeReq({
      authorization: 'Bearer app-jwt-token',
      'x-sep10-token': 'anchor-jwt',
    }, { amount: '100' });
    const res = makeRes();
    await deposit(req, res);
    expect(initiateDeposit).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), 'anchor-jwt', expect.any(Object)
    );
  });
});

describe('extractSep10Jwt — development (fallback enabled)', () => {
  beforeEach(() => freshApp('development'));

  test('deposit forwards Authorization Bearer token as sep10Jwt when X-Sep10-Token absent', async () => {
    const req = makeReq({ authorization: 'Bearer dev-fallback-jwt' }, { amount: '100' });
    const res = makeRes();
    await deposit(req, res);
    expect(initiateDeposit).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), 'dev-fallback-jwt', expect.any(Object)
    );
  });

  test('withdraw forwards Authorization Bearer token as sep10Jwt when X-Sep10-Token absent', async () => {
    const req = makeReq({ authorization: 'Bearer dev-fallback-jwt' }, { amount: '50' });
    const res = makeRes();
    await withdraw(req, res);
    expect(initiateWithdrawal).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), 'dev-fallback-jwt', expect.any(Object)
    );
  });

  test('dedicated X-Sep10-Token takes precedence over Authorization header in dev', async () => {
    const req = makeReq({
      authorization: 'Bearer app-jwt',
      'x-sep10-token': 'real-sep10-jwt',
    }, { amount: '100' });
    const res = makeRes();
    await deposit(req, res);
    expect(initiateDeposit).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), 'real-sep10-jwt', expect.any(Object)
    );
  });
});
