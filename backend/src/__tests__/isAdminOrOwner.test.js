/**
 * Unit tests for the isAdminOrOwner middleware factory.
 *
 * Covers:
 *   - No authentication → 401
 *   - Admin role → always passes, with and without resourceLoader
 *   - Non-admin, no resourceLoader → passes (controller scopes to req.user.userId)
 *   - Non-admin, resourceLoader, matching owner → passes
 *   - Non-admin, resourceLoader, mismatched owner (non-owner) → 403
 *   - Non-admin, resourceLoader, resource not found → 404
 *   - resourceLoader throws → next(err) called
 */

const isAdminOrOwner = require('../middleware/isAdminOrOwner');

// ---------- helpers ----------

function makeReq({ userId = 'user-abc', role = 'user' } = {}) {
  return { user: { userId, role } };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
  return res;
}

// ---------- tests ----------

describe('isAdminOrOwner middleware (no resourceLoader)', () => {
  test('returns 401 when req.user is not set', async () => {
    const middleware = isAdminOrOwner();
    const req = { user: undefined };
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(next).not.toHaveBeenCalled();
  });

  test('passes admin user through', async () => {
    const middleware = isAdminOrOwner();
    const req = makeReq({ role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200); // untouched
  });

  test('passes authenticated non-admin user through (controller enforces userId scope)', async () => {
    const middleware = isAdminOrOwner();
    const req = makeReq({ userId: 'user-123', role: 'user' });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });
});

describe('isAdminOrOwner middleware (with resourceLoader)', () => {
  test('returns 401 when req.user is not set', async () => {
    const loader = jest.fn();
    const middleware = isAdminOrOwner(loader);
    const req = { user: undefined };
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(loader).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('passes admin user through without calling resourceLoader', async () => {
    const loader = jest.fn();
    const middleware = isAdminOrOwner(loader);
    const req = makeReq({ role: 'admin' });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(loader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  test('passes when resourceLoader returns a resource owned by the authenticated user', async () => {
    const ownerId = 'user-abc';
    const loader = jest.fn().mockResolvedValue({ user_id: ownerId, id: 'resource-1' });
    const middleware = isAdminOrOwner(loader);
    const req = makeReq({ userId: ownerId, role: 'user' });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(loader).toHaveBeenCalledWith(req);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  test('returns 403 when resourceLoader returns a resource owned by a different user (non-owner)', async () => {
    const loader = jest.fn().mockResolvedValue({ user_id: 'other-user', id: 'resource-1' });
    const middleware = isAdminOrOwner(loader);
    const req = makeReq({ userId: 'user-abc', role: 'user' });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden: admin or account owner required' });
  });

  test('returns 404 when resourceLoader returns null (resource not found)', async () => {
    const loader = jest.fn().mockResolvedValue(null);
    const middleware = isAdminOrOwner(loader);
    const req = makeReq({ userId: 'user-abc', role: 'user' });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Resource not found' });
  });

  test('calls next(err) when resourceLoader throws', async () => {
    const error = new Error('DB connection failed');
    const loader = jest.fn().mockRejectedValue(error);
    const middleware = isAdminOrOwner(loader);
    const req = makeReq({ userId: 'user-abc', role: 'user' });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(error);
    expect(res.statusCode).toBe(200); // response untouched, error forwarded
  });
});
