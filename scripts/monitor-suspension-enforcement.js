#!/usr/bin/env node
/**
 * Monitoring Script: BE-104 - Suspension Enforcement
 * 
 * This script monitors and alerts on:
 * 1. Suspended users with active sessions
 * 2. Attempts to use revoked tokens (from logs)
 * 3. Suspension bypass attempts
 * 
 * Run periodically via cron or monitoring system:
 * */5 * * * * /path/to/monitor-suspension-enforcement.js
 */

const db = require('../backend/src/db');
const logger = require('../backend/src/utils/logger');
const cache = require('../backend/src/utils/cache');

// Configuration
const ALERT_THRESHOLD = {
  activeSessions: 5, // Alert if suspended user has this many active sessions
  revokedAttempts: 10, // Alert if this many revoked token attempts in window
  timeWindow: 300, // Time window in seconds (5 minutes)
};

async function checkSuspendedUsersWithActiveSessions() {
  const result = await db.query(`
    SELECT 
      u.id,
      u.email,
      u.suspension_reason,
      u.suspended_at,
      COUNT(s.id) as active_session_count,
      array_agg(s.ip_address) as session_ips,
      MAX(s.last_active_at) as most_recent_activity
    FROM users u
    INNER JOIN sessions s ON s.user_id = u.id
    WHERE u.is_suspended = TRUE 
      AND s.is_active = TRUE
      AND s.last_active_at > NOW() - INTERVAL '1 hour'
    GROUP BY u.id, u.email, u.suspension_reason, u.suspended_at
    HAVING COUNT(s.id) > 0
    ORDER BY COUNT(s.id) DESC
  `);

  if (result.rows.length > 0) {
    logger.warn('Suspended users with active sessions detected', {
      count: result.rows.length,
      users: result.rows.map(r => ({
        email: r.email,
        sessionCount: r.active_session_count,
        lastActivity: r.most_recent_activity,
      })),
    });

    // Alert if any user has more than threshold
    const highActivity = result.rows.filter(
      r => parseInt(r.active_session_count) >= ALERT_THRESHOLD.activeSessions
    );

    if (highActivity.length > 0) {
      logger.error('HIGH PRIORITY: Suspended user with many active sessions', {
        users: highActivity,
        action: 'Manual investigation required',
      });
      
      // In production, send to alerting system (PagerDuty, Slack, etc.)
      // await sendAlert('suspended_user_high_activity', highActivity);
    }
  }

  return result.rows;
}

async function checkRevokedTokenAttempts() {
  // Check Redis for recent TOKEN_REVOKED attempts
  // This assumes you're logging failed auth attempts to Redis with a key pattern
  const keys = await cache.keys('auth:failed:revoked:*');
  
  const recentAttempts = [];
  for (const key of keys) {
    const data = await cache.get(key);
    if (data) {
      try {
        const attempt = JSON.parse(data);
        recentAttempts.push(attempt);
      } catch (e) {
        // Skip invalid JSON
      }
    }
  }

  if (recentAttempts.length > ALERT_THRESHOLD.revokedAttempts) {
    logger.warn('High volume of revoked token attempts', {
      count: recentAttempts.length,
      threshold: ALERT_THRESHOLD.revokedAttempts,
      sample: recentAttempts.slice(0, 5),
    });

    // Group by IP to detect coordinated attacks
    const byIp = {};
    recentAttempts.forEach(attempt => {
      const ip = attempt.ip || 'unknown';
      byIp[ip] = (byIp[ip] || 0) + 1;
    });

    const suspiciousIps = Object.entries(byIp)
      .filter(([, count]) => count >= 5)
      .map(([ip, count]) => ({ ip, count }));

    if (suspiciousIps.length > 0) {
      logger.error('Potential credential theft or replay attack detected', {
        suspiciousIps,
        action: 'Consider IP blocking or rate limiting',
      });
      
      // In production, automatically trigger IP blocking
      // await blockSuspiciousIps(suspiciousIps);
    }
  }

  return recentAttempts;
}

async function checkSuspensionBypassAttempts() {
  // Check for login attempts by suspended users
  const result = await db.query(`
    SELECT 
      u.id,
      u.email,
      u.suspension_reason,
      COUNT(al.id) as attempt_count,
      array_agg(DISTINCT al.ip_address) as attempt_ips,
      MAX(al.created_at) as most_recent_attempt
    FROM users u
    INNER JOIN audit_logs al ON al.user_id = u.id
    WHERE u.is_suspended = TRUE
      AND al.action IN ('login_failure', 'login_success')
      AND al.created_at > NOW() - INTERVAL '1 hour'
    GROUP BY u.id, u.email, u.suspension_reason
    HAVING COUNT(al.id) > 0
    ORDER BY COUNT(al.id) DESC
  `);

  if (result.rows.length > 0) {
    logger.warn('Suspended users attempting to log in', {
      count: result.rows.length,
      users: result.rows,
    });

    // Check if any succeeded (should never happen after fix)
    const successfulLogins = await db.query(`
      SELECT 
        u.id,
        u.email,
        al.created_at,
        al.ip_address
      FROM users u
      INNER JOIN audit_logs al ON al.user_id = u.id
      WHERE u.is_suspended = TRUE
        AND al.action = 'login_success'
        AND al.created_at > NOW() - INTERVAL '1 hour'
    `);

    if (successfulLogins.rows.length > 0) {
      logger.error('CRITICAL: Suspended user successfully logged in!', {
        users: successfulLogins.rows,
        action: 'Fix verification required - suspension enforcement may be broken',
      });
      
      // In production, page on-call engineer immediately
      // await sendCriticalAlert('suspension_bypass_detected', successfulLogins.rows);
    }
  }

  return result.rows;
}

async function verifyEnforcement() {
  // Smoke test: verify the fix is still in place
  const authMiddlewarePath = require.resolve('../backend/src/middleware/auth');
  const authMiddlewareCode = require('fs').readFileSync(authMiddlewarePath, 'utf8');
  
  const hasJtiCheck = authMiddlewareCode.includes('isJtiBlacklisted');
  const hasSuspensionCheck = authMiddlewareCode.includes('is_suspended');
  
  if (!hasJtiCheck || !hasSuspensionCheck) {
    logger.error('CRITICAL: Suspension enforcement code is missing!', {
      hasJtiCheck,
      hasSuspensionCheck,
      action: 'Auth middleware may have been overwritten or reverted',
    });
    
    // In production, page on-call engineer immediately
    // await sendCriticalAlert('enforcement_code_missing', { hasJtiCheck, hasSuspensionCheck });
    return false;
  }
  
  return true;
}

async function generateReport() {
  const report = {
    timestamp: new Date().toISOString(),
    enforcement_verified: false,
    suspended_with_sessions: [],
    revoked_token_attempts: [],
    suspension_bypass_attempts: [],
    recommendations: [],
  };

  try {
    // Verify the fix is in place
    report.enforcement_verified = await verifyEnforcement();
    
    if (!report.enforcement_verified) {
      report.recommendations.push(
        'CRITICAL: Re-apply BE-104 fix immediately'
      );
      return report;
    }

    // Check suspended users with active sessions
    report.suspended_with_sessions = await checkSuspendedUsersWithActiveSessions();
    
    if (report.suspended_with_sessions.length > 0) {
      report.recommendations.push(
        `Review ${report.suspended_with_sessions.length} suspended users with active sessions. ` +
        'These sessions should be automatically revoked. Consider implementing active session termination.'
      );
    }

    // Check revoked token attempts
    report.revoked_token_attempts = await checkRevokedTokenAttempts();
    
    if (report.revoked_token_attempts.length > 20) {
      report.recommendations.push(
        'High volume of revoked token attempts detected. ' +
        'This may indicate credential theft or a replay attack. Review IPs and consider blocking.'
      );
    }

    // Check suspension bypass attempts
    report.suspension_bypass_attempts = await checkSuspensionBypassAttempts();
    
    if (report.suspension_bypass_attempts.length > 0) {
      report.recommendations.push(
        `${report.suspension_bypass_attempts.length} suspended users attempted to log in. ` +
        'This is expected behavior (attempts should fail). Monitor for successful logins.'
      );
    }

    // Summary
    logger.info('Suspension enforcement monitoring report', {
      summary: {
        enforcement_ok: report.enforcement_verified,
        suspended_with_sessions: report.suspended_with_sessions.length,
        revoked_attempts: report.revoked_token_attempts.length,
        bypass_attempts: report.suspension_bypass_attempts.length,
      },
    });

  } catch (error) {
    logger.error('Error generating suspension enforcement report', { error });
    report.error = error.message;
  }

  return report;
}

// Main execution
async function main() {
  console.log('=== BE-104 Suspension Enforcement Monitor ===\n');
  
  const report = await generateReport();
  
  console.log('\n=== Report Summary ===');
  console.log(`Timestamp: ${report.timestamp}`);
  console.log(`Enforcement Verified: ${report.enforcement_verified ? '✅' : '❌'}`);
  console.log(`Suspended with Sessions: ${report.suspended_with_sessions.length}`);
  console.log(`Revoked Token Attempts: ${report.revoked_token_attempts.length}`);
  console.log(`Bypass Attempts: ${report.suspension_bypass_attempts.length}`);
  
  if (report.recommendations.length > 0) {
    console.log('\n=== Recommendations ===');
    report.recommendations.forEach((rec, i) => {
      console.log(`${i + 1}. ${rec}`);
    });
  }
  
  // Exit with error code if critical issues found
  if (!report.enforcement_verified || 
      report.suspended_with_sessions.length > 10 ||
      report.revoked_token_attempts.length > 50) {
    console.log('\n⚠️  Critical issues detected!');
    process.exit(1);
  }
  
  console.log('\n✅ All checks passed');
  process.exit(0);
}

// Run if called directly
if (require.main === module) {
  main()
    .catch(err => {
      console.error('Fatal error:', err);
      process.exit(1);
    })
    .finally(() => {
      // Close database connections
      db.pool.end();
      cache.quit();
    });
}

module.exports = {
  generateReport,
  checkSuspendedUsersWithActiveSessions,
  checkRevokedTokenAttempts,
  checkSuspensionBypassAttempts,
  verifyEnforcement,
};
