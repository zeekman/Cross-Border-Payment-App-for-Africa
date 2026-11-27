import { fiatValueForTx } from '../fxSnapshot';

describe('fiatValueForTx (FE-206)', () => {
  const live = { USD: 0.5, NGN: 800, GHS: 5, KES: 60 };

  test('uses the snapshot rate when fx_snapshot is present', () => {
    const tx = { amount: '100', asset: 'XLM', fx_snapshot: { rates: { NGN: 176 }, source: 'coingecko', at: '2025-01-01T00:00:00Z' } };
    const fiat = fiatValueForTx(tx, 'NGN', live);
    expect(fiat.atSendTime).toBe(true);
    expect(fiat.value).toBe('17600.00');
    expect(fiat.rate).toBe(176);
    expect(fiat.source).toBe('coingecko');
  });

  test("falls back to today's rate and marks it when there is no snapshot", () => {
    const fiat = fiatValueForTx({ amount: '100', asset: 'XLM' }, 'NGN', live);
    expect(fiat.atSendTime).toBe(false);
    expect(fiat.value).toBe('80000.00');
  });

  test('returns null for non-XLM assets or XLM display currency', () => {
    expect(fiatValueForTx({ amount: '1', asset: 'USDC' }, 'NGN', live)).toBeNull();
    expect(fiatValueForTx({ amount: '1', asset: 'XLM' }, 'XLM', live)).toBeNull();
  });
});
