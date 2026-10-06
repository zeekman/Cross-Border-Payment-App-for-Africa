'use strict';

/**
 * BE-032: every AML flag override must be traceable to the reviewing admin,
 * with a mandatory reason, via the shared audit trail (services/audit.js).
 */

jest.mock('../db', () => ({ query: jest.fn() }));

const db = require('../db');
const { overrideAmlFlag, getAmlOverrides } = require('../controllers/adminController');

function mockRes() {
  return { json: jest.fn(), status: jest.fn().mockReturnThis() };
}

describe('overrideAmlFlag (BE-032 audit trail)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects an override with no reason', async () => {
    const req = {
      body: { wallet_address: 'GABC', new_status: 'cleared' },
      user: { userId: 'admin-1', role: 'admin' },
      ip: '1.2.3.4',
      headers: {},
    };
    const res = mockRes();
    const next = jest.fn();

    await overrideAmlFlag(req, res, next);

    expect(db.query).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  test('rejects an override with a blank/whitespace-only reason', async () => {
    const req = {
      body: { wallet_address: 'GABC', reason: '   ', new_status: 'cleared' },
      user: { userId: 'admin-1', role: 'admin' },
      ip: '1.2.3.4',
      headers: {},
    };
    const res = mockRes();
    const next = jest.fn();

    await overrideAmlFlag(req, res, next);

    expect(db.query).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  test('writes admin identity, timestamp (via auditLog) and reason to the audit trail', async () => {
    db.query.mockResolvedValue({ rows: [] });

    const req = {
      body: { wallet_address: 'GABC', reason: 'Confirmed false positive after manual review', new_status: 'cleared' },
      user: { userId: 'admin-42', role: 'admin' },
      ip: '1.2.3.4',
      headers: { 'user-agent': 'jest' },
    };
    const res = mockRes();
    const next = jest.fn();

    await overrideAmlFlag(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO audit_logs');
    // params: [userId, role, action, resource_type, resource_id, old_value, new_value, ip, user_agent]
    expect(params[0]).toBe('admin-42'); // reviewing admin id
    expect(params[2]).toBe('aml_override');
    expect(params[3]).toBe('aml_flag');
    const newValue = JSON.parse(params[6]);
    expect(newValue.reason).toBe('Confirmed false positive after manual review');
    expect(newValue.reviewing_admin_id).toBe('admin-42');

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        reviewing_admin_id: 'admin-42',
        new_status: 'cleared',
      })
    );
  });
});

describe('getAmlOverrides (BE-032 compliance report)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('filters by action=aml_override and optional date range', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 1 }] });
    const req = { query: { from: '2024-01-01', to: '2024-02-01' } };
    const res = mockRes();
    const next = jest.fn();

    await getAmlOverrides(req, res, next);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("action = 'aml_override'");
    expect(sql).toContain('created_at >=');
    expect(sql).toContain('created_at <=');
    expect(params).toEqual(['2024-01-01', '2024-02-01']);
    expect(res.json).toHaveBeenCalledWith({ data: [{ id: 1 }] });
  });
});
