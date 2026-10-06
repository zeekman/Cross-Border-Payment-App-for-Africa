jest.mock('../db', () => ({ query: jest.fn() }));

const db = require('../db');
const { enqueueMint } = require('../services/loyaltyMintQueue');

describe('enqueueMint', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a transaction-linked row using the live queue schema', async () => {
    await enqueueMint({
      transactionId: 'aaaaaaaa-0000-4000-8000-000000000001',
      userId: 'bbbbbbbb-0000-4000-8000-000000000002',
      walletAddress: 'GABC',
      amount: '12.5',
      asset: 'USDC',
    });

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO loyalty_mint_queue \(id, user_id, sender_wallet, amount, asset\)/i);
    expect(sql).not.toMatch(/wallet_address|points/);
    expect(params).toEqual([
      'aaaaaaaa-0000-4000-8000-000000000001',
      'bbbbbbbb-0000-4000-8000-000000000002',
      'GABC',
      '12.5',
      'USDC',
    ]);
  });
});
