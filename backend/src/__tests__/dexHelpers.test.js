'use strict';

/**
 * Unit tests for dex service helpers: parseAssetParam and simulateFill.
 * No mocking of Horizon — these are pure computation tests.
 */

// Provide env issuer for plain CODE tests
process.env.USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

// Mock stellar service so resolveAsset doesn't need Horizon
jest.mock('../services/stellar', () => ({
  resolveAsset: jest.fn((code) => {
    const StellarSdk = require('@stellar/stellar-sdk');
    if (code === 'XLM') return StellarSdk.Asset.native();
    const issuer = process.env[`${code}_ISSUER`];
    if (!issuer) throw Object.assign(new Error(`${code}_ISSUER not configured`), { status: 500 });
    return new StellarSdk.Asset(code, issuer);
  }),
  decryptPrivateKey: jest.fn(),
  sendPathPayment: jest.fn(),
  findPaymentPath: jest.fn(),
}));

const StellarSdk = require('@stellar/stellar-sdk');
const { parseAssetParam, simulateFill } = require('../services/dex');

const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

// ---------------------------------------------------------------------------
// parseAssetParam
// ---------------------------------------------------------------------------
describe('parseAssetParam', () => {
  test('returns native asset for XLM', () => {
    const asset = parseAssetParam('XLM');
    expect(asset.isNative()).toBe(true);
  });

  test('returns issued asset for CODE:ISSUER format', () => {
    const asset = parseAssetParam(`USDC:${ISSUER}`);
    expect(asset.getCode()).toBe('USDC');
    expect(asset.getIssuer()).toBe(ISSUER);
  });

  test('is case-insensitive (lowercase input)', () => {
    const asset = parseAssetParam(`usdc:${ISSUER.toLowerCase()}`);
    expect(asset.getCode()).toBe('USDC');
  });

  test('resolves plain CODE via env issuer', () => {
    const asset = parseAssetParam('USDC');
    expect(asset.getCode()).toBe('USDC');
    expect(asset.getIssuer()).toBe(ISSUER);
  });

  test('throws 400 for null input', () => {
    expect(() => parseAssetParam(null)).toThrow(expect.objectContaining({ status: 400 }));
  });

  test('throws 400 for invalid code in CODE:ISSUER format', () => {
    expect(() => parseAssetParam(`BAD!CODE:${ISSUER}`)).toThrow(expect.objectContaining({ status: 400 }));
  });

  test('throws 400 for malformed issuer in CODE:ISSUER format', () => {
    expect(() => parseAssetParam('USDC:NOTANISSUER')).toThrow(expect.objectContaining({ status: 400 }));
  });

  test('throws 400 for empty string', () => {
    expect(() => parseAssetParam('')).toThrow(expect.objectContaining({ status: 400 }));
  });
});

// ---------------------------------------------------------------------------
// simulateFill
// ---------------------------------------------------------------------------
describe('simulateFill', () => {
  const asks = [
    { price: '0.1', amount: '100' },
    { price: '0.11', amount: '200' },
    { price: '0.12', amount: '300' },
  ];

  test('fills exactly from first level', () => {
    const result = simulateFill(asks, 50);
    expect(result.filledAmount).toBe(50);
    expect(result.estimatedPrice).toBeCloseTo(0.1, 6);
    expect(result.insufficientLiquidity).toBe(false);
  });

  test('fills across multiple levels', () => {
    const result = simulateFill(asks, 150);
    expect(result.filledAmount).toBe(150);
    // 100 * 0.1 + 50 * 0.11 = 10 + 5.5 = 15.5 / 150 = 0.10333...
    expect(result.estimatedPrice).toBeCloseTo(15.5 / 150, 5);
    expect(result.insufficientLiquidity).toBe(false);
  });

  test('fills completely available liquidity and flags insufficient', () => {
    const result = simulateFill(asks, 1000); // more than 600 total
    expect(result.insufficientLiquidity).toBe(true);
    expect(result.filledAmount).toBe(600);
    expect(result.maxFillableAmount).toBe(600);
  });

  test('returns insufficientLiquidity false when exactly fills', () => {
    const result = simulateFill(asks, 600);
    expect(result.insufficientLiquidity).toBe(false);
    expect(result.filledAmount).toBe(600);
  });

  test('returns null estimatedPrice and zero filled for empty asks', () => {
    const result = simulateFill([], 100);
    expect(result.estimatedPrice).toBeNull();
    expect(result.filledAmount).toBe(0);
    expect(result.insufficientLiquidity).toBe(true);
    expect(result.maxFillableAmount).toBe(0);
  });
});
