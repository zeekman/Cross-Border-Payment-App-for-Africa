import { Keypair } from '@stellar/stellar-sdk';
import { validateEscrowForm, toStroops } from '../escrowValidation';

const SENDER = Keypair.random().publicKey();
const AGENT = Keypair.random().publicKey();
const RECIPIENT = Keypair.random().publicKey();

const valid = { agent_wallet: AGENT, recipient_wallet: RECIPIENT, amount: '10.5', asset: 'USDC' };

// Change the last character so the CRC16 checksum no longer matches.
const breakChecksum = (addr) => addr.slice(0, -1) + (addr.endsWith('A') ? 'B' : 'A');

describe('validateEscrowForm', () => {
  test('accepts a valid form', () => {
    expect(validateEscrowForm(valid, { senderWallet: SENDER, balance: '100' })).toBeNull();
  });

  test('rejects a G… address with a bad checksum', () => {
    expect(validateEscrowForm({ ...valid, agent_wallet: breakChecksum(AGENT) })).toMatchObject({
      field: 'agent_wallet',
      key: 'agent_invalid',
    });
  });

  test.each(['0', '1', '8', '9'])('rejects non-base32 digit %s', (digit) => {
    const addr = AGENT.slice(0, 10) + digit + AGENT.slice(11);
    expect(validateEscrowForm({ ...valid, recipient_wallet: addr })).toMatchObject({
      field: 'recipient_wallet',
      key: 'recipient_invalid',
    });
  });

  test('requires sender, agent and recipient to differ', () => {
    expect(validateEscrowForm({ ...valid, agent_wallet: SENDER }, { senderWallet: SENDER }).key).toBe(
      'agent_is_sender'
    );
    expect(
      validateEscrowForm({ ...valid, recipient_wallet: SENDER }, { senderWallet: SENDER }).key
    ).toBe('recipient_is_sender');
    expect(validateEscrowForm({ ...valid, recipient_wallet: AGENT }).key).toBe('recipient_is_agent');
  });

  test('only allows USDC', () => {
    expect(validateEscrowForm({ ...valid, asset: 'XLM' })).toMatchObject({
      field: 'asset',
      key: 'asset_unsupported',
    });
  });

  test.each([
    ['', 'amount_required'],
    ['1.12345678', 'amount_format'],
    ['-1', 'amount_format'],
    ['1e3', 'amount_format'],
    ['0', 'amount_positive'],
    ['0.0000000', 'amount_positive'],
  ])('rejects amount %p with %s', (amount, key) => {
    expect(validateEscrowForm({ ...valid, amount }).key).toBe(key);
  });

  test('accepts exactly 7 decimals', () => {
    expect(validateEscrowForm({ ...valid, amount: '0.0000001' })).toBeNull();
  });

  test('rejects an amount above the available balance', () => {
    expect(validateEscrowForm({ ...valid, amount: '100.0000001' }, { balance: '100.0000000' })).toMatchObject({
      key: 'insufficient_balance',
      params: { balance: '100.0000000', asset: 'USDC' },
    });
    expect(validateEscrowForm({ ...valid, amount: '100' }, { balance: '100.0000000' })).toBeNull();
  });
});

describe('toStroops', () => {
  test('converts without float error', () => {
    expect(toStroops('0.1')).toBe(1000000n);
    expect(toStroops('1.0000001')).toBe(10000001n);
    expect(toStroops('abc')).toBeNull();
  });
});
