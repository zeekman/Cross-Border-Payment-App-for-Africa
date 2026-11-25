'use strict';

/**
 * Tests for the shared AES key derivation helper and all five Soroban-facing
 * services that previously embedded their own broken decryptSecret().
 *
 * All service-level tests use a 44-character base64 ENCRYPTION_KEY — a
 * real-world secret that is NOT exactly 32 bytes and is NOT hex.  This is
 * the exact class of value that caused "Invalid key length" with the old
 * Buffer.from(ENCRYPTION_KEY) pattern.
 *
 * Services under test:
 *   agentEscrow       — confirmPayout, cancelEscrow
 *   disputeResolution — openDispute, submitEvidence, resolveDispute
 *   feeDistributor    — depositFee
 *   kycAttestation    — attestKyc, revokeKyc
 *   loyaltyToken      — mintPoints, redeemPoints
 */

// ---------------------------------------------------------------------------
// Test ENCRYPTION_KEY — 44-char base64 string, deliberately NOT 32 chars/hex
// ---------------------------------------------------------------------------
const TEST_KEY = 'dGhpcyBpcyBhIHRlc3Qga2V5IGZvciBBZnJpUGF5IQ=='; // 44 chars

// ---------------------------------------------------------------------------
// Mock Stellar SDK (no real network calls)
// ---------------------------------------------------------------------------
jest.mock('@stellar/stellar-sdk', () => {
  const FAKE_PUB = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';
  const fakeKeypair = { publicKey: () => FAKE_PUB, sign: jest.fn() };
  const fakeTx      = { sign: jest.fn() };
  const fakeRpc = {
    getAccount:          jest.fn().mockResolvedValue({ id: FAKE_PUB, sequence: '100' }),
    prepareTransaction:  jest.fn().mockResolvedValue(fakeTx),
    sendTransaction:     jest.fn().mockResolvedValue({ status: 'SUCCESS', hash: 'fakehash' }),
    getTransaction:      jest.fn().mockResolvedValue({ status: 'SUCCESS', returnValue: null }),
    getFeeStats:         jest.fn().mockResolvedValue({ sorobanInclusionFee: { p90: '200' } }),
    simulateTransaction: jest.fn().mockResolvedValue({ result: { retval: null } }),
  };
  return {
    Networks:   { TESTNET: 'Test SDF Network ; September 2015', PUBLIC: 'Public Global Stellar Network ; September 2015' },
    BASE_FEE:   100,
    Keypair:    { fromSecret: jest.fn(() => fakeKeypair), random: jest.fn(() => fakeKeypair) },
    SorobanRpc: { Server: jest.fn(() => fakeRpc), Api: { isSimulationError: jest.fn(() => false) } },
    Contract:   jest.fn(() => ({ call: jest.fn(() => ({})) })),
    TransactionBuilder: jest.fn(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout:   jest.fn().mockReturnThis(),
      build:        jest.fn(() => fakeTx),
    })),
    nativeToScVal: jest.fn(v => v),
    scValToNative: jest.fn(() => true),
    xdr: { ScVal: { scvBytes: jest.fn(v => v) } },
  };
});

jest.mock('../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// ===========================================================================
// 1. deriveAesKey — unit tests for the shared helper itself
// ===========================================================================

describe('deriveAesKey', () => {
  let deriveAesKey;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.ENCRYPTION_KEY;
    deriveAesKey = require('../utils/symmetricEncryption').deriveAesKey;
  });

  test('returns a 32-byte Buffer for a 44-char base64 key', () => {
    const result = deriveAesKey(TEST_KEY);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(32);
  });

  test('is deterministic — same input always produces the same key', () => {
    expect(deriveAesKey(TEST_KEY).equals(deriveAesKey(TEST_KEY))).toBe(true);
  });

  test('produces different keys for different inputs', () => {
    const a = deriveAesKey('aaaa-bbbb-cccc-dddd-eeee-ffff-0000-1111');
    const b = deriveAesKey('different-secret-value-entirely-here!');
    expect(a.equals(b)).toBe(false);
  });

  test('works with a plain 32-char ASCII passphrase', () => {
    expect(deriveAesKey('exactly-32-character-passphrase!').length).toBe(32);
  });

  test('works with a UUID (36 chars with hyphens)', () => {
    expect(deriveAesKey('550e8400-e29b-41d4-a716-446655440000').length).toBe(32);
  });

  test('reads process.env.ENCRYPTION_KEY when no argument is passed', () => {
    process.env.ENCRYPTION_KEY = TEST_KEY;
    expect(deriveAesKey().length).toBe(32);
  });

  test('throws when key is an empty string', () => {
    expect(() => deriveAesKey('')).toThrow('ENCRYPTION_KEY is not set');
  });

  test('throws when key is shorter than 16 characters', () => {
    expect(() => deriveAesKey('tooshort')).toThrow(/too short/i);
  });

  test('throws when process.env.ENCRYPTION_KEY is absent', () => {
    expect(() => deriveAesKey()).toThrow('ENCRYPTION_KEY is not set');
  });
});

// ===========================================================================
// 2. encryptAesCbc / decryptAesCbc round-trip
// ===========================================================================

describe('encryptAesCbc / decryptAesCbc round-trip', () => {
  let encryptAesCbc, decryptAesCbc;

  beforeEach(() => {
    jest.resetModules();
    ({ encryptAesCbc, decryptAesCbc } = require('../utils/symmetricEncryption'));
  });

  test('round-trips a Stellar secret key with the 44-char test key', () => {
    const secret = 'SCZANGBA5YELC3GIQHB7UFQRRMOBZFCUTEZJ5RM5LUHBXCUCBBDJFHX';
    expect(decryptAesCbc(encryptAesCbc(secret, TEST_KEY), TEST_KEY)).toBe(secret);
  });

  test('ciphertext has <iv_hex>:<ciphertext_hex> format', () => {
    expect(encryptAesCbc('payload', TEST_KEY)).toMatch(/^[0-9a-f]{32}:[0-9a-f]+$/i);
  });

  test('same plaintext produces different ciphertexts each time (random IV)', () => {
    const a = encryptAesCbc('same-input', TEST_KEY);
    const b = encryptAesCbc('same-input', TEST_KEY);
    expect(a).not.toBe(b);
  });

  test('throws on malformed ciphertext (no colon separator)', () => {
    expect(() => decryptAesCbc('notvalidformat', TEST_KEY))
      .toThrow(/invalid encrypted format/i);
  });

  test('round-trips successfully for keys of 16, 32, and 44 chars', () => {
    const payload = 'stellar-secret-key';
    for (const key of ['exactly-sixteen!', 'exactly-32-character-passphrase!', TEST_KEY]) {
      expect(decryptAesCbc(encryptAesCbc(payload, key), key)).toBe(payload);
    }
  });
});

// ===========================================================================
// Helper: produce a valid ciphertext encrypted with TEST_KEY.
// Called after jest.resetModules() so it picks up the freshest module state.
// ===========================================================================
function makeEncrypted(plaintext = 'SCZANGBA5YELC3GIQHB7UFQRRMOBZFCUTEZJ5RM5LUHBXCUCBBDJFHX') {
  const { encryptAesCbc } = require('../utils/symmetricEncryption');
  return encryptAesCbc(plaintext, TEST_KEY);
}

// ===========================================================================
// 3. agentEscrow
// ===========================================================================

describe('agentEscrow — decrypt succeeds with 44-char non-hex key', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.ENCRYPTION_KEY              = TEST_KEY;
    process.env.AGENT_ESCROW_CONTRACT_ID    = 'CTEST_ESCROW';
    process.env.STELLAR_NETWORK             = 'testnet';
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
    delete process.env.AGENT_ESCROW_CONTRACT_ID;
  });

  test('confirmPayout does not throw Invalid key length', async () => {
    const { confirmPayout } = require('../services/agentEscrow');
    await expect(
      confirmPayout({ encryptedSecretKey: makeEncrypted(), escrowId: '1' })
    ).resolves.not.toThrow();
  });

  test('cancelEscrow does not throw Invalid key length', async () => {
    const { cancelEscrow } = require('../services/agentEscrow');
    await expect(
      cancelEscrow({ encryptedSecretKey: makeEncrypted(), escrowId: '1' })
    ).resolves.not.toThrow();
  });
});

// ===========================================================================
// 4. disputeResolution
// ===========================================================================

describe('disputeResolution — decrypt succeeds with 44-char non-hex key', () => {
  const ADDR_A = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';
  const ADDR_B = 'GDSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU4';

  beforeEach(() => {
    jest.resetModules();
    process.env.ENCRYPTION_KEY                  = TEST_KEY;
    process.env.DISPUTE_RESOLUTION_CONTRACT_ID  = 'CTEST_DISPUTE';
    process.env.STELLAR_NETWORK                 = 'testnet';
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
    delete process.env.DISPUTE_RESOLUTION_CONTRACT_ID;
  });

  test('openDispute does not throw Invalid key length', async () => {
    const { openDispute } = require('../services/disputeResolution');
    await expect(
      openDispute({ encryptedSecretKey: makeEncrypted(), sender: ADDR_A, recipient: ADDR_B, amount: '100' })
    ).resolves.not.toThrow();
  });

  test('submitEvidence does not throw Invalid key length', async () => {
    const { submitEvidence } = require('../services/disputeResolution');
    await expect(
      submitEvidence({ encryptedSecretKey: makeEncrypted(), disputeId: '1', evidence: 'QmIPFSCid' })
    ).resolves.not.toThrow();
  });

  test('resolveDispute does not throw Invalid key length', async () => {
    const { resolveDispute } = require('../services/disputeResolution');
    await expect(
      resolveDispute({ encryptedArbitratorKey: makeEncrypted(), disputeId: '1', releaseToRecipient: true })
    ).resolves.not.toThrow();
  });
});

// ===========================================================================
// 5. feeDistributor
// ===========================================================================

describe('feeDistributor — decrypt succeeds with 44-char non-hex key', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.ENCRYPTION_KEY                = TEST_KEY;
    process.env.FEE_DISTRIBUTOR_CONTRACT_ID   = 'CTEST_FEE';
    process.env.STELLAR_NETWORK               = 'testnet';
    process.env.SERVICE_ENCRYPTED_SECRET_KEY  = makeEncrypted();
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
    delete process.env.FEE_DISTRIBUTOR_CONTRACT_ID;
    delete process.env.SERVICE_ENCRYPTED_SECRET_KEY;
  });

  test('depositFee does not throw Invalid key length', async () => {
    const { depositFee } = require('../services/feeDistributor');
    await expect(depositFee(100)).resolves.not.toThrow();
  });

  test('depositFee throws when FEE_DISTRIBUTOR_CONTRACT_ID is missing', async () => {
    delete process.env.FEE_DISTRIBUTOR_CONTRACT_ID;
    const { depositFee } = require('../services/feeDistributor');
    await expect(depositFee(100)).rejects.toThrow('FEE_DISTRIBUTOR_CONTRACT_ID');
  });

  test('depositFee throws when SERVICE_ENCRYPTED_SECRET_KEY is missing', async () => {
    delete process.env.SERVICE_ENCRYPTED_SECRET_KEY;
    const { depositFee } = require('../services/feeDistributor');
    await expect(depositFee(100)).rejects.toThrow('SERVICE_ENCRYPTED_SECRET_KEY');
  });
});

// ===========================================================================
// 6. kycAttestation
// ===========================================================================

describe('kycAttestation — decrypt succeeds with 44-char non-hex key', () => {
  const ADMIN  = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';
  const USER_W = 'GDSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU4';

  beforeEach(() => {
    jest.resetModules();
    process.env.ENCRYPTION_KEY              = TEST_KEY;
    process.env.KYC_ATTESTATION_CONTRACT_ID = 'CTEST_KYC';
    process.env.STELLAR_NETWORK             = 'testnet';
    process.env.ADMIN_ENCRYPTED_SECRET_KEY  = makeEncrypted();
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
    delete process.env.KYC_ATTESTATION_CONTRACT_ID;
    delete process.env.ADMIN_ENCRYPTED_SECRET_KEY;
  });

  test('attestKyc does not throw Invalid key length', async () => {
    const { attestKyc } = require('../services/kycAttestation');
    await expect(
      attestKyc(ADMIN, USER_W, 'user-uuid-1234', 'passport')
    ).resolves.not.toThrow();
  });

  test('revokeKyc does not throw Invalid key length', async () => {
    const { revokeKyc } = require('../services/kycAttestation');
    await expect(revokeKyc(ADMIN, USER_W)).resolves.not.toThrow();
  });
});

// ===========================================================================
// 7. loyaltyToken
// ===========================================================================

describe('loyaltyToken — decrypt succeeds with 44-char non-hex key', () => {
  const WALLET = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';

  beforeEach(() => {
    jest.resetModules();
    process.env.ENCRYPTION_KEY            = TEST_KEY;
    process.env.LOYALTY_TOKEN_CONTRACT_ID = 'CTEST_LOYALTY';
    process.env.STELLAR_NETWORK           = 'testnet';
    process.env.LOYALTY_ADMIN_KEY         = makeEncrypted();
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
    delete process.env.LOYALTY_TOKEN_CONTRACT_ID;
    delete process.env.LOYALTY_ADMIN_KEY;
  });

  test('mintPoints does not throw Invalid key length', async () => {
    const { mintPoints } = require('../services/loyaltyToken');
    await expect(
      mintPoints({ recipientWallet: WALLET, points: 10 })
    ).resolves.not.toThrow();
  });

  test('redeemPoints does not throw Invalid key length', async () => {
    const { redeemPoints } = require('../services/loyaltyToken');
    await expect(
      redeemPoints({ encryptedSecretKey: makeEncrypted(), walletAddress: WALLET })
    ).resolves.not.toThrow();
  });

  test('mintPoints returns null when LOYALTY_TOKEN_CONTRACT_ID is unset', async () => {
    delete process.env.LOYALTY_TOKEN_CONTRACT_ID;
    const { mintPoints } = require('../services/loyaltyToken');
    expect(await mintPoints({ recipientWallet: WALLET, points: 5 })).toBeNull();
  });

  test('mintPoints returns null when LOYALTY_ADMIN_KEY is unset', async () => {
    delete process.env.LOYALTY_ADMIN_KEY;
    const { mintPoints } = require('../services/loyaltyToken');
    expect(await mintPoints({ recipientWallet: WALLET, points: 5 })).toBeNull();
  });
});

// ===========================================================================
// 8. Cross-service consistency
// ===========================================================================

describe('cross-service key derivation consistency', () => {
  test('deriveAesKey produces the same 32-byte key on every call with the same env var', () => {
    jest.resetModules();
    process.env.ENCRYPTION_KEY = TEST_KEY;
    const { deriveAesKey } = require('../utils/symmetricEncryption');

    const k1 = deriveAesKey();
    const k2 = deriveAesKey();
    const k3 = deriveAesKey();

    expect(k1.length).toBe(32);
    expect(k1.equals(k2)).toBe(true);
    expect(k2.equals(k3)).toBe(true);

    delete process.env.ENCRYPTION_KEY;
  });

  test('a ciphertext encrypted with TEST_KEY decrypts correctly via process.env', () => {
    jest.resetModules();
    process.env.ENCRYPTION_KEY = TEST_KEY;

    const { encryptAesCbc, decryptAesCbc } = require('../utils/symmetricEncryption');
    const plaintext  = 'SCZANGBA5YELC3GIQHB7UFQRRMOBZFCUTEZJ5RM5LUHBXCUCBBDJFHX';
    const ciphertext = encryptAesCbc(plaintext, TEST_KEY);

    // Five independent decryption calls (one per service) — all must succeed
    for (let i = 0; i < 5; i++) {
      expect(decryptAesCbc(ciphertext)).toBe(plaintext);
    }

    delete process.env.ENCRYPTION_KEY;
  });
});
