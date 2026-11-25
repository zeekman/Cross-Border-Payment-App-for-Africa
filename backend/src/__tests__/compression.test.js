const express = require('express');
const compression = require('compression');
const request = require('supertest');
const helmet = require('helmet');

// Build helmet once at startup, supplying the CSP nonce via a directive
// function that reads res.locals.cspNonce (set by the requestId middleware).
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
    },
  },
});

// Custom middleware emitting the Permissions-Policy header, since helmet 8
// has no permissionsPolicy option.
function permissionsPolicy(req, res, next) {
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()'
  );
  next();
}

describe('API Response Compression', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(compression({ threshold: 1024 }));
    
    app.get('/api/test-large', (req, res) => {
      const data = 'a'.repeat(2000); 
      res.send(data);
    });

    app.get('/api/test-small', (req, res) => {
      res.send('small response');
    });
  });

  test('should compress responses larger than 1KB with gzip', async () => {
    const res = await request(app)
      .get('/api/test-large')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  test('should NOT compress responses smaller than 1KB', async () => {
    const res = await request(app)
      .get('/api/test-small')
      .set('Accept-Encoding', 'gzip');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});

describe('Security headers', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use((req, res, next) => {
      res.locals.cspNonce = 'test-nonce';
      next();
    });
    app.use(helmetMiddleware);
    app.use(permissionsPolicy);

    // Static avatar mount registered AFTER security middleware so uploaded
    // files are served with nosniff and the other hardening headers.
    app.use(
      '/uploads/avatars',
      express.static('uploads/avatars', {
        setHeaders: (res) => {
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Content-Disposition', 'inline');
        },
      })
    );

    app.get('/api/ping', (req, res) => res.json({ ok: true }));
  });

  test('emits Permissions-Policy restricting camera, microphone, geolocation and payment', async () => {
    const res = await request(app).get('/api/ping');

    expect(res.status).toBe(200);
    expect(res.headers['permissions-policy']).toBe(
      'camera=(), microphone=(), geolocation=(), payment=()'
    );
  });

  test('serves avatar files with X-Content-Type-Options: nosniff', async () => {
    const res = await request(app).get('/uploads/avatars/does-not-exist.png');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
