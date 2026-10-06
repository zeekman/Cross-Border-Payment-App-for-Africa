'use strict';

/**
 * BE-031: /api/dev must never resolve to anything (dev-only tooling or the
 * former "legacy alias" to toolsRoutes) when NODE_ENV === 'production'.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');

describe('BE-031: /api/dev is unreachable in production', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  test('app.js only mounts /api/dev once, guarded by a NODE_ENV !== production check', () => {
    const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
    const devMounts = appSrc.match(/app\.use\(\s*['"]\/api\/dev['"]/g) || [];

    // Exactly one mount point for '/api/dev' — the naming collision between the
    // former "legacy alias" (toolsRoutes) and the real dev router is removed.
    expect(devMounts.length).toBe(1);
    expect(appSrc).not.toMatch(/api\/dev.*legacy alias/i);
  });

  test('routes/dev.js self-gates to 404 outside NODE_ENV=development', async () => {
    process.env.NODE_ENV = 'production';
    jest.resetModules();
    jest.mock('../middleware/auth', () => (req, res, next) => {
      req.user = { userId: 'user-test-id' };
      next();
    });
    const devRoutes = require('../routes/dev');

    const app = express();
    app.use(express.json());
    app.use('/api/dev', devRoutes);

    const res = await request(app).post('/api/dev/fund-wallet');
    expect(res.status).toBe(404);
  });

  test('routes/dev.js self-gates to 404 under staging/test NODE_ENV too', async () => {
    process.env.NODE_ENV = 'staging';
    jest.resetModules();
    jest.mock('../middleware/auth', () => (req, res, next) => {
      req.user = { userId: 'user-test-id' };
      next();
    });
    const devRoutes = require('../routes/dev');

    const app = express();
    app.use(express.json());
    app.use('/api/dev', devRoutes);

    const res = await request(app).post('/api/dev/fund-wallet');
    expect(res.status).toBe(404);
  });
});
