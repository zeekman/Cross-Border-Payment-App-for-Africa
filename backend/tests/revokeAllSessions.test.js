jest.mock('../src/db', () => ({
  query: jest.fn(),
}));
jest.mock('../src/utils/cache', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
}));

const db = require('../src/db');
const { revokeAllSessions } = require('../src/controllers/sessionController');

// Token used only to compute a stable Authorization header for the "current
// session" hash — the controller only hashes it, it never verifies the JWT.
const CURRENT_TOKEN = 'header.payload.signature';

function buildReq({ authorization = `Bearer ${CURRENT_TOKEN}`, query = {} } = {}) {
  return {
    user: { userId: 'user-1' },
    headers: authorization ? { authorization } : {},
    query,
  };
}

function buildRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('DELETE /api/auth/sessions (revokeAllSessions) — BE-028', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('excludes the caller current session by default (safer default)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ token_jti: 'jti-other-1' }, { token_jti: 'jti-other-2' }] });

    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    await revokeAllSessions(req, res, next);

    // The query should exclude the current session's token_hash.
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/token_hash != \$2/);
    expect(params[0]).toBe('user-1');

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        current_session_revoked: false,
        revoked_count: 2,
        message: 'All other sessions revoked',
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('revokes the current session too when include_current=true is explicitly passed', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ token_jti: 'jti-1' }] });

    const req = buildReq({ query: { include_current: 'true' } });
    const res = buildRes();
    const next = jest.fn();

    await revokeAllSessions(req, res, next);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).not.toMatch(/token_hash != \$2/);
    expect(params).toEqual(['user-1']);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        current_session_revoked: true,
        message: 'All sessions revoked, including this device',
      })
    );
  });

  it('legacy keep_current=false is treated the same as include_current=true', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const req = buildReq({ query: { keep_current: 'false' } });
    const res = buildRes();

    await revokeAllSessions(req, res, jest.fn());

    const [sql] = db.query.mock.calls[0];
    expect(sql).not.toMatch(/token_hash != \$2/);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ current_session_revoked: true })
    );
  });
});
