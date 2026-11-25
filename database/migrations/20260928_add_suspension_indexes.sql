-- Migration: Add indexes and verify columns for suspension enforcement
-- Issue: BE-104 - Access token revocation and suspension enforcement
-- Date: 2026-09-28

BEGIN;

-- Verify that is_suspended column exists
-- (Should already exist from bulk-suspend feature, but verify)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'users' 
          AND column_name = 'is_suspended'
    ) THEN
        ALTER TABLE users ADD COLUMN is_suspended BOOLEAN NOT NULL DEFAULT FALSE;
        COMMENT ON COLUMN users.is_suspended IS 'Whether the user account has been suspended by an administrator';
    END IF;
END $$;

-- Verify that suspension_reason column exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'users' 
          AND column_name = 'suspension_reason'
    ) THEN
        ALTER TABLE users ADD COLUMN suspension_reason TEXT;
        COMMENT ON COLUMN users.suspension_reason IS 'Reason provided by admin for account suspension';
    END IF;
END $$;

-- Verify that suspended_at column exists for audit trail
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'users' 
          AND column_name = 'suspended_at'
    ) THEN
        ALTER TABLE users ADD COLUMN suspended_at TIMESTAMPTZ;
        COMMENT ON COLUMN users.suspended_at IS 'Timestamp when the account was suspended';
    END IF;
END $$;

-- Add partial index for suspended users (for fast lookups)
-- Only indexes rows where is_suspended = TRUE (typically small subset)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_suspended 
ON users(is_suspended) 
WHERE is_suspended = TRUE;

COMMENT ON INDEX idx_users_suspended IS 
'Partial index for fast suspension checks in auth middleware. Only indexes suspended accounts.';

-- Verify that sessions table has token_jti column
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'sessions' 
          AND column_name = 'token_jti'
    ) THEN
        ALTER TABLE sessions ADD COLUMN token_jti TEXT;
        COMMENT ON COLUMN sessions.token_jti IS 'JWT ID (jti) claim from the access token, used for revocation tracking';
    END IF;
END $$;

-- Add index on sessions.token_jti for fast JTI lookups
-- Used when checking if a JTI has been blacklisted via session revocation
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_token_jti 
ON sessions(token_jti) 
WHERE token_jti IS NOT NULL;

COMMENT ON INDEX idx_sessions_token_jti IS 
'Index for fast JTI lookups when checking token revocation status';

-- Add index on sessions for active sessions lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_active_user 
ON sessions(user_id, is_active) 
WHERE is_active = TRUE;

COMMENT ON INDEX idx_sessions_active_user IS 
'Index for fast active session lookups per user, used in session management endpoints';

-- Create a view for monitoring suspended accounts
CREATE OR REPLACE VIEW v_suspended_accounts AS
SELECT 
    u.id,
    u.email,
    u.full_name,
    u.is_suspended,
    u.suspension_reason,
    u.suspended_at,
    COUNT(s.id) as active_session_count,
    MAX(s.last_active_at) as last_session_activity
FROM users u
LEFT JOIN sessions s ON s.user_id = u.id AND s.is_active = TRUE
WHERE u.is_suspended = TRUE
GROUP BY u.id, u.email, u.full_name, u.is_suspended, u.suspension_reason, u.suspended_at
ORDER BY u.suspended_at DESC NULLS LAST;

COMMENT ON VIEW v_suspended_accounts IS 
'View for monitoring suspended accounts and their active sessions. Used by admin dashboard.';

-- Create a function to suspend a user (for use in triggers or stored procedures)
CREATE OR REPLACE FUNCTION suspend_user(
    p_user_id UUID,
    p_reason TEXT,
    p_admin_id UUID DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    UPDATE users 
    SET 
        is_suspended = TRUE,
        suspension_reason = p_reason,
        suspended_at = NOW()
    WHERE id = p_user_id;
    
    -- Log the suspension in audit_logs if the table exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_logs') THEN
        INSERT INTO audit_logs (user_id, action, ip_address, user_agent, metadata)
        VALUES (
            p_user_id,
            'account_suspended',
            '0.0.0.0',
            'system',
            jsonb_build_object(
                'reason', p_reason,
                'suspended_by', p_admin_id,
                'suspended_at', NOW()
            )
        );
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION suspend_user IS 
'Function to suspend a user account with audit trail. Can be called from application code or triggers.';

-- Create a function to unsuspend a user
CREATE OR REPLACE FUNCTION unsuspend_user(
    p_user_id UUID,
    p_admin_id UUID DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    UPDATE users 
    SET 
        is_suspended = FALSE,
        suspension_reason = NULL,
        suspended_at = NULL
    WHERE id = p_user_id;
    
    -- Log the unsuspension in audit_logs if the table exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_logs') THEN
        INSERT INTO audit_logs (user_id, action, ip_address, user_agent, metadata)
        VALUES (
            p_user_id,
            'account_unsuspended',
            '0.0.0.0',
            'system',
            jsonb_build_object(
                'unsuspended_by', p_admin_id,
                'unsuspended_at', NOW()
            )
        );
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION unsuspend_user IS 
'Function to unsuspend a user account with audit trail. Can be called from application code or triggers.';

-- Add helpful statistics view for monitoring
CREATE OR REPLACE VIEW v_suspension_stats AS
SELECT 
    COUNT(*) FILTER (WHERE is_suspended = TRUE) as total_suspended,
    COUNT(*) FILTER (WHERE is_suspended = TRUE AND suspended_at > NOW() - INTERVAL '24 hours') as suspended_last_24h,
    COUNT(*) FILTER (WHERE is_suspended = TRUE AND suspended_at > NOW() - INTERVAL '7 days') as suspended_last_week,
    COUNT(*) FILTER (WHERE is_suspended = TRUE AND suspended_at > NOW() - INTERVAL '30 days') as suspended_last_month,
    COUNT(DISTINCT suspension_reason) FILTER (WHERE is_suspended = TRUE) as unique_suspension_reasons
FROM users;

COMMENT ON VIEW v_suspension_stats IS 
'Statistics view for monitoring suspension trends. Used by admin dashboard and monitoring.';

COMMIT;

-- Verification queries (run these manually after migration)
-- 1. Check that indexes were created
-- SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'users' AND indexname LIKE '%suspended%';
-- SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'sessions' AND indexname LIKE '%jti%';

-- 2. Check suspended accounts
-- SELECT * FROM v_suspended_accounts;

-- 3. Check suspension statistics
-- SELECT * FROM v_suspension_stats;

-- 4. Test the suspend/unsuspend functions
-- SELECT suspend_user('user-uuid-here'::UUID, 'Test suspension');
-- SELECT unsuspend_user('user-uuid-here'::UUID);
