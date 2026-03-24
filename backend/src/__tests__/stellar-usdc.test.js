// Shared mock server instance — must be defined before jest.mock hoisting
const mockServer = {
  loadAccount: jest.fn(),
  fetchBaseFee: jest.fn().mockResolvedValue(100),
  submitTransaction: jest.fn()
};

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      Server: jest.fn().mockImplementation(() => mockServer)
    }
  };
});

const stellar = require('../services/stellar');

describe('USDC / non-XLM asset support', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('resolveAsset', () => {
    test('throws 500 when USDC_ISSUER env var is not set', async () => {
      delete process.env.USDC_ISSUER;

      await expect(
        stellar.sendPayment({
          senderPublicKey: 'GABC',
          encryptedSecretKey: 'dummy',
          recipientPublicKey: 'GXYZ',
          amount: '10',
          asset: 'USDC'
        })
      ).rejects.toMatchObject({
        status: 500,
        message: expect.stringContaining('USDC_ISSUER is not configured')
      });
    });
  });

  describe('checkTrustline', () => {
    const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

    beforeEach(() => {
      process.env.USDC_ISSUER = ISSUER;
      process.env.ENCRYPTION_KEY = 'a'.repeat(32);
    });

    test('throws 400 when recipient account does not exist', async () => {
      const notFoundErr = { response: { status: 404 } };
      mockServer.loadAccount.mockRejectedValue(notFoundErr);

      await expect(
        stellar.sendPayment({
          senderPublicKey: 'GABC',
          encryptedSecretKey: 'dummy',
          recipientPublicKey: 'GXYZ',
          amount: '10',
          asset: 'USDC'
        })
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('does not exist')
      });
    });

    test('throws 400 when recipient has no USDC trustline', async () => {
      mockServer.loadAccount.mockResolvedValue({
        balances: [{ asset_type: 'native', balance: '100' }]
      });

      await expect(
        stellar.sendPayment({
          senderPublicKey: 'GABC',
          encryptedSecretKey: 'dummy',
          recipientPublicKey: 'GXYZ',
          amount: '10',
          asset: 'USDC'
        })
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('no USDC trustline')
      });
    });
  });
});
