const express = require('express');
const compression = require('compression');
const request = require('supertest');

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
