import { parseScannedPayment } from './parseScannedPayment';

const G = 'GADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOZPI';
const M = 'MADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA6OSU';

// Mirrors how ReceiveMoney builds its QR payload.
const receiveUri = (fields) => `web+stellar:pay?${new URLSearchParams(fields).toString()}`;

const codeOf = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
};

describe('parseScannedPayment', () => {
  it('accepts a plain G-address', () => {
    expect(parseScannedPayment(`  ${G} `)).toEqual({ destination: G });
  });

  it('accepts a muxed M-address and a federation address', () => {
    expect(parseScannedPayment(M)).toEqual({ destination: M });
    expect(parseScannedPayment('alice*afripay.com')).toEqual({ destination: 'alice*afripay.com' });
  });

  it('rejects an address with an invalid checksum', () => {
    const bad = `${G.slice(0, -1)}A`;
    expect(codeOf(() => parseScannedPayment(bad))).toBe('invalid_address');
  });

  it('parses a SEP-7 pay URI from /receive with amount and memo', () => {
    expect(parseScannedPayment(receiveUri({ destination: G, amount: '25.5', memo: 'Rent' }))).toEqual({
      destination: G,
      amount: '25.5',
      memo: 'Rent',
    });
  });

  it('decodes escaped memo text', () => {
    const memo = 'Lunch & drinks = 100% #paid';
    expect(parseScannedPayment(receiveUri({ destination: G, memo })).memo).toBe(memo);
    expect(parseScannedPayment(`web+stellar:pay?destination=${G}&memo=caf%C3%A9%20au%2Blait`).memo).toBe('café au+lait');
  });

  it('normalises memo_type and keeps asset fields', () => {
    const uri = receiveUri({ destination: G, memo: '42', memo_type: 'MEMO_ID', asset_code: 'USDC', asset_issuer: G });
    expect(parseScannedPayment(uri)).toMatchObject({ memo_type: 'id', asset_code: 'USDC', asset_issuer: G });
  });

  it('rejects unsupported URI types', () => {
    expect(codeOf(() => parseScannedPayment('web+stellar:tx?xdr=AAAA'))).toBe('unsupported_uri');
  });

  it('rejects a pay URI with an invalid destination', () => {
    expect(codeOf(() => parseScannedPayment('web+stellar:pay?destination=GBAD'))).toBe('invalid_address');
  });

  it('rejects arbitrary text', () => {
    expect(codeOf(() => parseScannedPayment('hello world'))).toBe('invalid');
  });
});
