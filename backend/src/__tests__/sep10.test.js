const { postChallenge } = require('../controllers/sep10Controller');
const StellarSdk = require('@stellar/stellar-sdk');

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

// Mock stellar.js so networkPassphrase is the testnet value
jest.mock('../services/stellar', () => ({
  networkPassphrase: 'Test SDF Network ; September 2015',
}));

// Mock sep10 service — not under test here
jest.mock('../services/sep10', () => ({
  generateChallenge: jest.fn(),
  verifyChallenge: jest.fn().mockReturnValue(true),
}));

// Mock db
jest.mock('../db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [{ id: 'user-1', email: 'test@example.com' }] }),
}));

function makeReq(body) {
  return { body, query: {} };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// Build a valid testnet XDR once for all tests
const keypair = StellarSdk.Keypair.random();
const validXDR = (() => {
  const account = new StellarSdk.Account(keypair.publicKey(), '0');
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(StellarSdk.Operation.manageData({ name: 'test', value: 'x' }))
    .setTimeout(30)
    .build();
  tx.sign(keypair);
  return tx.toEnvelope().toXDR('base64');
})();

describe('postChallenge — network passphrase verification', () => {
  test('returns 400 when network_passphrase is missing', async () => {
    const req = makeReq({ transaction: validXDR });
    const res = makeRes();
    await postChallenge(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid network passphrase' });
  });

  test('returns 400 when network_passphrase is mainnet (cross-network replay)', async () => {
    const req = makeReq({ transaction: validXDR, network_passphrase: MAINNET_PASSPHRASE });
    const res = makeRes();
    await postChallenge(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid network passphrase' });
  });

  test('proceeds when network_passphrase matches configured network', async () => {
    const req = makeReq({ transaction: validXDR, network_passphrase: TESTNET_PASSPHRASE });
    const res = makeRes();
    const next = jest.fn();
    await postChallenge(req, res, next);
    // Passphrase check passed — no 400 for passphrase mismatch
    expect(res.status).not.toHaveBeenCalledWith(400);
    // Either a token was issued or next() was called with a non-passphrase error
    const passphraseMismatch = res.json.mock.calls.some(
      ([body]) => body && body.error === 'Invalid network passphrase'
    );
    expect(passphraseMismatch).toBe(false);
  });
});
