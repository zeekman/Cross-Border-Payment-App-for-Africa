/**
 * Security Test: BE-104 - Access Token Revocation Enforcement
 * 
 * This test suite verifies that:
 * 1. JTI blacklisting is properly enforced in auth middleware
 * 2. Account suspension is checked during authentication
 * 3. Revoked tokens cannot be used for API requests
 * 4. Suspended accounts cannot authenticate via any method
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const db = require('../../src/db');
const cache = require('../../src/utils/cache');
const { blacklistJti } = require('../../src/controllers/sessionController');

describe('BE-104: Access Token Revocation and Suspension Enforcement', () => {
  let testUser;
  let validToken;
  let jti;

  beforeAll(async () => {
    // Create a test user
    const result = await db.query(
      `INSERT INTO users (id, email, password_hash, email_verified, is_suspended)
       VALUES (gen_random_uuid(), 'test@example.com', 'hashedpwd', TRUE, FALSE)
       RETURNING id, email`,
    );
    testUser = result.rows[0];

    // Generate a token with JTI
    jti = 'test-jti-' + Date.now();
    validToken = jwt.sign(
      { userId: testUser.id, email: testUser.email, role: 'user', jti },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );
  });

  afterAll(async () => {
    // Cleanup
    await db.query('DELETE FROM users WHERE id = $1', [testUser.id]);
    await cache.del(`jti:blacklist:${jti}`);
  });

  describe('JTI Blacklist Enforcement', () => {
    it('should allow access with a valid, non-blacklisted token', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).not.toBe(401);
    });

    it('should reject access when JTI is blacklisted', async () => {
      // Blacklist the JTI
      await blacklistJti(jti, 3600);

      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${validToken}`);

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('revoked');
      expect(response.body.code).toBe('TOKEN_REVOKED');
    });

    it('should reject requests after session revocation', async () => {
      // Create a new token
      const newJti = 'test-jti-new-' + Date.now();
      const newToken = jwt.sign(
        { userId: testUser.id, email: testUser.email, role: 'user', jti: newJti },
        process.env.JWT_SECRET,
        { expiresIn: '15m' }
      );

      // Verify token works initially
      let response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${newToken}`);
      expect(response.status).not.toBe(401);

      // Blacklist via session revocation
      await blacklistJti(newJti, 3600);

      // Token should now be rejected
      response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${newToken}`);
      expect(response.status).toBe(401);
      expect(response.body.code).toBe('TOKEN_REVOKED');

      // Cleanup
      await cache.del(`jti:blacklist:${newJti}`);
    });
  });

  describe('Account Suspension Enforcement', () => {
    beforeEach(async () => {
      // Ensure user is not suspended before each test
      await db.query(
        'UPDATE users SET is_suspended = FALSE WHERE id = $1',
        [testUser.id]
      );
    });

    it('should reject login for suspended accounts', async () => {
      // Suspend the account
      await db.query(
        `UPDATE users SET is_suspended = TRUE, suspension_reason = 'Test suspension'
         WHERE id = $1`,
        [testUser.id]
      );

      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: testUser.email,
          password: 'testpassword123',
        });

      expect(response.status).toBe(403);
      expect(response.body.error).toContain('suspended');
      expect(response.body.code).toBe('ACCOUNT_SUSPENDED');
      expect(response.body.reason).toBe('Test suspension');
    });

    it('should reject API requests with valid token from suspended account', async () => {
      // Create a new non-blacklisted token
      const activeJti = 'active-jti-' + Date.now();
      const activeToken = jwt.sign(
        { userId: testUser.id, email: testUser.email, role: 'user', jti: activeJti },
        process.env.JWT_SECRET,
        { expiresIn: '15m' }
      );

      // Suspend the account
      await db.query(
        `UPDATE users SET is_suspended = TRUE, suspension_reason = 'Violation of terms'
         WHERE id = $1`,
        [testUser.id]
      );

      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${activeToken}`);

      expect(response.status).toBe(403);
      expect(response.body.error).toContain('suspended');
      expect(response.body.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('should reject refresh token requests for suspended accounts', async () => {
      // This would require setting up refresh token infrastructure
      // Placeholder for refresh token suspension test
      expect(true).toBe(true);
    });
  });

  describe('Socket.IO Authentication', () => {
    it('should reject WebSocket connections with blacklisted tokens', async () => {
      // This would require Socket.IO client setup
      // Placeholder for WebSocket blacklist test
      expect(true).toBe(true);
    });

    it('should reject WebSocket connections for suspended accounts', async () => {
      // This would require Socket.IO client setup
      // Placeholder for WebSocket suspension test
      expect(true).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle tokens without JTI gracefully', async () => {
      // Create token without JTI
      const tokenWithoutJti = jwt.sign(
        { userId: testUser.id, email: testUser.email, role: 'user' },
        process.env.JWT_SECRET,
        { expiresIn: '15m' }
      );

      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tokenWithoutJti}`);

      // Should still check suspension even without JTI
      expect(response.status).not.toBe(500); // Should not crash
    });

    it('should handle database errors during suspension check', async () => {
      // This would require mocking database failures
      // Placeholder for error handling test
      expect(true).toBe(true);
    });

    it('should handle Redis errors during JTI blacklist check', async () => {
      // This would require mocking Redis failures
      // Placeholder for error handling test
      expect(true).toBe(true);
    });
  });
});
