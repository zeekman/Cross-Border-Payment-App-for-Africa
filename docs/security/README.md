# Security Documentation

This directory contains security-related documentation, fix reports, and best practices for the Cross-Border Payment App.

## Security Fixes

### BE-104: Access Token Revocation & Account Suspension Enforcement
**Status:** ✅ Fixed | **Date:** 2026-09-28 | **Severity:** CRITICAL

Session revocation and account suspension were implemented but never enforced, allowing suspended users and revoked tokens to continue accessing the system.

**Documentation:**
- [📋 Fix Report](./BE-104-FIX-REPORT.md) - Comprehensive technical documentation
- [⚡ Quick Reference](./BE-104-QUICK-REFERENCE.md) - Developer guide and troubleshooting
- [📝 Summary](../../SECURITY-FIX-BE-104-SUMMARY.md) - Executive summary

**Files Changed:**
- `backend/src/middleware/auth.js` - Added JTI blacklist and suspension checks
- `backend/src/controllers/authController.js` - Added suspension checks in login/refresh
- `backend/src/index.js` - Added checks in Socket.IO authentication

**Testing:**
- Test Suite: `backend/tests/security/BE-104-token-revocation.test.js`
- Verification: `scripts/verify-be104-fix.js`
- Monitoring: `scripts/monitor-suspension-enforcement.js`

**Database:**
- Migration: `database/migrations/20260928_add_suspension_indexes.sql`

---

## Security Best Practices

### Authentication & Authorization

#### Token Management
1. **Always include JTI in access tokens**
   ```javascript
   const jti = uuidv4();
   const token = jwt.sign({ userId, email, role, jti }, secret, { expiresIn: '15m' });
   ```

2. **Blacklist revoked tokens in Redis**
   ```javascript
   await cache.set(`jti:blacklist:${jti}`, 1, ttlSeconds);
   ```

3. **Check blacklist in auth middleware**
   ```javascript
   if (payload.jti) {
     const blacklisted = await isJtiBlacklisted(payload.jti);
     if (blacklisted) {
       return res.status(401).json({ error: 'Token revoked', code: 'TOKEN_REVOKED' });
     }
   }
   ```

#### Account Suspension
1. **Check suspension in all authentication points**
   - Login endpoint (before password verification)
   - Token refresh endpoint
   - Auth middleware (for all protected routes)
   - WebSocket authentication

2. **Use consistent error codes**
   - `TOKEN_REVOKED` (401) - For revoked sessions
   - `ACCOUNT_SUSPENDED` (403) - For suspended accounts

3. **Always provide suspension reason to user**
   ```javascript
   return res.status(403).json({
     error: 'Account suspended',
     reason: suspensionReason || 'Please contact support',
     code: 'ACCOUNT_SUSPENDED'
   });
   ```

#### Session Management
1. **Enforce session limits** (currently 5 per user)
2. **Implement session revocation** for security events:
   - Password change → revoke all sessions
   - Suspicious activity → revoke affected sessions
   - User request → revoke specific or all sessions

3. **Track session metadata**
   - Device type, IP address, location
   - Last activity timestamp
   - User agent string

### Database Security

#### Indexes for Performance
```sql
-- Partial index for suspended users
CREATE INDEX idx_users_suspended ON users(is_suspended) 
WHERE is_suspended = TRUE;

-- Index for JTI lookups
CREATE INDEX idx_sessions_token_jti ON sessions(token_jti) 
WHERE token_jti IS NOT NULL;
```

#### Sensitive Data
1. **Never store plaintext secrets**
   - Passwords: bcrypt with salt
   - Tokens: SHA-256 hash only
   - API keys: Encrypted or hashed

2. **Use separate columns for sensitive data**
   - `password_hash` (not `password`)
   - `token_hash` (not `token`)
   - `totp_secret` (encrypted)

### Redis Security

#### Key Naming Conventions
```
jti:blacklist:{jti}           - Blacklisted JWT IDs
session:touch:{tokenHash}      - Session touch debounce
user:{userId}:suspended        - Cached suspension status (future)
auth:failed:revoked:{ip}       - Failed auth attempts from revoked tokens
```

#### TTL Best Practices
1. **Match token expiration**
   ```javascript
   const ttl = Math.floor((tokenExpiry - Date.now()) / 1000);
   await cache.set(key, value, ttl);
   ```

2. **Use reasonable defaults**
   - Session touch debounce: 5 minutes
   - Blacklisted tokens: Until natural expiry
   - Cached user data: 5-10 minutes

### API Security

#### Rate Limiting
Apply rate limits to sensitive endpoints:
- `/api/auth/login` - 5 requests/min per IP
- `/api/auth/refresh` - 10 requests/min per IP
- `/api/auth/forgot-password` - 3 requests/hour per IP

#### Input Validation
Always validate and sanitize:
- Email addresses (normalize, validate format)
- Passwords (check complexity)
- User-provided strings (escape, trim, length check)

#### CORS Configuration
```javascript
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
  maxAge: 86400
}));
```

### WebSocket Security

#### Authentication
```javascript
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check JTI blacklist
    if (payload.jti && await isJtiBlacklisted(payload.jti)) {
      return next(new Error('Token has been revoked'));
    }
    
    // Check account suspension
    const { rows } = await db.query(
      'SELECT is_suspended FROM users WHERE id = $1',
      [payload.userId]
    );
    if (rows[0]?.is_suspended) {
      return next(new Error('Account suspended'));
    }
    
    socket.userId = payload.userId;
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});
```

#### Room Authorization
```javascript
// Only join rooms the user is authorized for
socket.join(`user:${socket.userId}`);
socket.join(`wallet:${userWalletAddress}`);
// Don't allow arbitrary room joining
```

### Monitoring & Alerting

#### What to Monitor
1. **Failed authentication attempts**
   - High volume from single IP
   - Pattern of revoked token usage
   - Suspended users attempting login

2. **Successful authentications**
   - Suspended users (should never happen)
   - Unusual patterns (location, time, device)

3. **Session activity**
   - Active sessions for suspended users
   - Session cap violations
   - Long-running sessions

#### Alerting Thresholds
```javascript
const ALERT_THRESHOLDS = {
  revokedTokenAttempts: 10,  // per 5 minutes
  suspendedLoginAttempts: 5,  // per hour
  activeSuspendedSessions: 3, // absolute
  failedLogins: 20            // per 5 minutes, per IP
};
```

### Incident Response

#### If Suspension Bypass Detected
1. Verify fix is still deployed
2. Check database: `SELECT * FROM v_suspended_accounts;`
3. Force logout all sessions: Run revocation script
4. Investigate logs for root cause
5. Patch immediately if regression found

#### If Mass Token Revocation Detected
1. Check for credential theft patterns
2. Review IP addresses and geolocations
3. Block suspicious IPs if coordinated attack
4. Notify affected users
5. Consider forcing password reset

### Testing Requirements

#### Unit Tests
- JTI blacklist enforcement
- Suspension check in all auth points
- Error code consistency
- Edge cases (missing JTI, DB errors, etc.)

#### Integration Tests
- End-to-end suspension flow
- End-to-end revocation flow
- WebSocket authentication
- Multi-session scenarios

#### Security Tests
- Attempt to bypass suspension
- Attempt to use revoked tokens
- Race conditions in session management
- Performance under load

---

## Related Documentation

- [Main README](../../README.md)
- [API Documentation](../api/)
- [Database Schema](../../database/)
- [Deployment Guide](../deployment/)

## Security Contact

- **Security Team:** security@example.com
- **Slack:** #security-team
- **On-Call:** PagerDuty "Security" escalation
- **Bug Bounty:** https://example.com/security/bug-bounty

---

**Last Updated:** 2026-09-28  
**Next Review:** 2026-12-28 (Quarterly)
