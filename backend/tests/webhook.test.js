jest.mock('../src/db');
jest.mock('../src/utils/symmetricEncryption', () => ({
  encryptSecret: (s) => `enc:${s}`,
  decryptSecret: (s) => s.replace(/^enc:/, ''),
}));

const crypto = require('crypto');
const db = require('../src/db');
const { sign, deliver } = require('../src/services/webhook');
const { create, list } = require('../src/controllers/webhookController');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => jest.clearAllMocks());

// ── webhook service ──────────────────────────────────────────────────────────

describe('webhook service: sign', () => {
  test('produces correct HMAC-SHA256 hex signature', () => {
    const secret = 'mysecret';
    const payload = '{"event":"payment.sent"}';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    expect(sign(secret, payload)).toBe(expected);
  });

  test('different secrets produce different signatures', () => {
    const payload = '{"event":"payment.sent"}';
    expect(sign('secret1', payload)).not.toBe(sign('secret2', payload));
  });
});

describe('webhook service: deliver', () => {
  test('queries only the event owner\'s active webhooks subscribed to the event', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await deliver('payment.sent', 'u1', { id: 'tx1' });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('active = true'),
      ['payment.sent', 'u1']
    );
  });

  test('does not throw when no webhooks are registered', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await expect(deliver('payment.sent', 'u1', {})).resolves.toBeUndefined();
  });
});

// ── webhook controller ───────────────────────────────────────────────────────

describe('webhookController: create', () => {
  test('returns 400 when URL is not HTTPS', async () => {
    const req = { user: { userId: 'u1' }, body: { url: 'http://example.com', events: ['payment.sent'] } };
    const res = mockRes();
    await create(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('HTTPS') }));
  });

  test('returns 400 for invalid event names', async () => {
    const req = { user: { userId: 'u1' }, body: { url: 'https://example.com', events: ['payment.unknown'] } };
    const res = mockRes();
    await create(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('Invalid events') }));
  });

  test('creates webhook and returns plain secret on success', async () => {
    const row = { id: 'wh-1', url: 'https://example.com', events: ['payment.sent'], active: true, created_at: new Date().toISOString() };
    db.query.mockResolvedValue({ rows: [row] });

    const req = { user: { userId: 'u1' }, body: { url: 'https://example.com', events: ['payment.sent'] } };
    const res = mockRes();
    await create(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(201);
    const payload = res.json.mock.calls[0][0];
    expect(payload).toMatchObject({ id: 'wh-1', url: 'https://example.com' });
    // Plain 64-char hex secret returned once on creation
    expect(typeof payload.secret).toBe('string');
    expect(payload.secret.length).toBe(64);
  });

  test('stores the encrypted secret in the database', async () => {
    const row = { id: 'wh-1', url: 'https://example.com', events: [], active: true, created_at: new Date().toISOString() };
    db.query.mockResolvedValue({ rows: [row] });

    const req = { user: { userId: 'u1' }, body: { url: 'https://example.com', events: [] } };
    const res = mockRes();
    await create(req, res, jest.fn());

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO webhooks/);
    // The stored secret starts with 'enc:' (our mock prefix) — not the plain 64-char hex
    const storedSecret = params[2];
    expect(storedSecret.startsWith('enc:')).toBe(true);
    expect(storedSecret).not.toBe(res.json.mock.calls[0][0].secret);
  });

  test('accepts empty events array', async () => {
    const row = { id: 'wh-2', url: 'https://example.com', events: [], active: true, created_at: new Date().toISOString() };
    db.query.mockResolvedValue({ rows: [row] });

    const req = { user: { userId: 'u1' }, body: { url: 'https://example.com', events: [] } };
    const res = mockRes();
    await create(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('webhookController: list', () => {
  test('returns webhooks with masked secret for the authenticated user', async () => {
    const rows = [
      { id: 'wh-1', url: 'https://a.com', events: ['payment.sent'], active: true, created_at: new Date().toISOString(), secret: 'enc:abcd1234rest' },
    ];
    db.query.mockResolvedValue({ rows });

    const req = { user: { userId: 'u1' } };
    const res = mockRes();
    await list(req, res, jest.fn());

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('user_id = $1'), ['u1']);
    const { webhooks } = res.json.mock.calls[0][0];
    expect(webhooks).toHaveLength(1);
    // Plain secret must not be exposed
    expect(webhooks[0].secret).toBeUndefined();
    // Masked version: first 4 chars of decrypted ('abcd') + '****'
    expect(webhooks[0].secret_masked).toBe('abcd****');
  });

  test('returns empty array when user has no webhooks', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const req = { user: { userId: 'u2' } };
    const res = mockRes();
    await list(req, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith({ webhooks: [] });
  });

  test('calls next(err) on db failure', async () => {
    const err = new Error('db error');
    db.query.mockRejectedValue(err);
    const req = { user: { userId: 'u1' } };
    const res = mockRes();
    const next = jest.fn();
    await list(req, res, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});
