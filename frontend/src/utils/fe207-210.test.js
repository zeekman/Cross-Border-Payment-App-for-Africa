import { Account, Keypair, MuxedAccount } from '@stellar/stellar-sdk';
import { buildCurrencies, convertFromXLM, formatAmount } from './currency';
import { parseMuxedAddress, validateStellarAddress } from './validation';
import { summariseLimits } from '../hooks/useLimits';

test('all API currencies are listed', () => {
  expect(buildCurrencies(['NGN', { code: 'XOF', name: 'CFA' }, 'UGX']).map((c) => c.code)).toEqual(['XLM', 'NGN', 'XOF', 'UGX']);
});

test('minor units follow the currency and missing rates show a dash', () => {
  expect(formatAmount(1600, 'XOF', 'en')).not.toMatch(/\.\d/);
  expect(formatAmount(1600, 'UGX', 'en')).not.toMatch(/\.\d/);
  expect(formatAmount(1600, 'NGN', 'en')).toMatch(/1,600\.00/);
  expect(formatAmount(convertFromXLM('10', 'NGN', {}), 'NGN')).toBe('—');
});

test('muxed addresses validate and decode', () => {
  const g = Keypair.random().publicKey();
  const m = new MuxedAccount(new Account(g, '0'), '12345').accountId();
  expect(validateStellarAddress(m)).toBeNull();
  expect(parseMuxedAddress(m)).toEqual({ baseAccount: g, id: '12345' });
  expect(validateStellarAddress(`${m.slice(0, -1)}!`)).toMatch(/Invalid muxed/);
});

test('max is the tightest remaining limit', () => {
  expect(summariseLimits({ daily: { limit: 100, used: 40 }, monthly: { limit: 50, used: 0 }, single_tx_max: 80 }).max).toBe(50);
});
