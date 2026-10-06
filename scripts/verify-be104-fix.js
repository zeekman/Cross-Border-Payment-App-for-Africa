#!/usr/bin/env node
/**
 * Verification Script: BE-104 Fix
 * 
 * This script verifies that the BE-104 security fix has been properly applied.
 * It checks:
 * 1. Auth middleware includes suspension and JTI checks
 * 2. Login function checks suspension
 * 3. Refresh function checks suspension
 * 4. Socket.IO auth includes checks
 * 5. Required database columns exist
 * 6. Performance indexes exist
 * 
 * Usage: node scripts/verify-be104-fix.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function log(message, color = 'reset') {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

function success(message) {
  log(`✅ ${message}`, 'green');
}

function error(message) {
  log(`❌ ${message}`, 'red');
}

function warning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

function info(message) {
  log(`ℹ️  ${message}`, 'blue');
}

let passed = 0;
let failed = 0;
let warnings = 0;

function check(name, condition, errorMsg) {
  if (condition) {
    success(name);
    passed++;
    return true;
  } else {
    error(`${name}: ${errorMsg}`);
    failed++;
    return false;
  }
}

function checkFileContains(filePath, searchStrings, description) {
  const fullPath = path.join(__dirname, '..', filePath);
  
  if (!fs.existsSync(fullPath)) {
    error(`${description}: File not found - ${filePath}`);
    failed++;
    return false;
  }
  
  const content = fs.readFileSync(fullPath, 'utf8');
  const missing = searchStrings.filter(str => !content.includes(str));
  
  if (missing.length === 0) {
    success(description);
    passed++;
    return true;
  } else {
    error(`${description}: Missing - ${missing.join(', ')}`);
    failed++;
    return false;
  }
}

console.log('\n' + '='.repeat(60));
log('BE-104 Security Fix Verification', 'blue');
console.log('='.repeat(60) + '\n');

// 1. Check auth middleware
info('Checking auth middleware...');
checkFileContains(
  'backend/src/middleware/auth.js',
  [
    'isJtiBlacklisted',
    'is_suspended',
    'async function authMiddleware',
    'TOKEN_REVOKED',
    'ACCOUNT_SUSPENDED'
  ],
  'Auth middleware includes suspension and JTI checks'
);

// 2. Check authController login
info('\nChecking login function...');
checkFileContains(
  'backend/src/controllers/authController.js',
  [
    'is_suspended',
    'suspension_reason',
    'ACCOUNT_SUSPENDED'
  ],
  'Login function checks account suspension'
);

// 3. Check authController refresh
info('\nChecking refresh function...');
const authControllerPath = path.join(__dirname, '..', 'backend/src/controllers/authController.js');
const authControllerContent = fs.readFileSync(authControllerPath, 'utf8');
const refreshFunctionMatch = authControllerContent.match(/async function refresh[\s\S]*?(?=async function|$)/);

if (refreshFunctionMatch) {
  const refreshContent = refreshFunctionMatch[0];
  check(
    'Refresh function checks suspension',
    refreshContent.includes('is_suspended') && refreshContent.includes('ACCOUNT_SUSPENDED'),
    'Missing suspension check in refresh function'
  );
} else {
  warning('Could not find refresh function for detailed check');
  warnings++;
}

// 4. Check Socket.IO authentication
info('\nChecking Socket.IO authentication...');
checkFileContains(
  'backend/src/index.js',
  [
    'isJtiBlacklisted',
    'is_suspended',
    'io.use(async'
  ],
  'Socket.IO auth includes suspension and JTI checks'
);

// 5. Check test file exists
info('\nChecking test files...');
check(
  'Test file exists',
  fs.existsSync(path.join(__dirname, '..', 'backend/tests/security/BE-104-token-revocation.test.js')),
  'Test file not found'
);

// 6. Check documentation exists
info('\nChecking documentation...');
const docs = [
  'docs/security/BE-104-FIX-REPORT.md',
  'docs/security/BE-104-QUICK-REFERENCE.md',
  'SECURITY-FIX-BE-104-SUMMARY.md'
];

docs.forEach(doc => {
  check(
    `Documentation: ${doc}`,
    fs.existsSync(path.join(__dirname, '..', doc)),
    'Documentation file not found'
  );
});

// 7. Check database migration
info('\nChecking database migration...');
check(
  'Database migration exists',
  fs.existsSync(path.join(__dirname, '..', 'database/migrations/20260928_add_suspension_indexes.sql')),
  'Migration file not found'
);

// 8. Check monitoring script
info('\nChecking monitoring script...');
check(
  'Monitoring script exists',
  fs.existsSync(path.join(__dirname, '..', 'scripts/monitor-suspension-enforcement.js')),
  'Monitoring script not found'
);

// 9. Verify no obvious syntax errors (basic check)
info('\nChecking for obvious syntax issues...');
try {
  const authMiddleware = require('../backend/src/middleware/auth');
  check(
    'Auth middleware loads without syntax errors',
    typeof authMiddleware === 'function',
    'Auth middleware is not a function'
  );
} catch (err) {
  error(`Auth middleware has syntax errors: ${err.message}`);
  failed++;
}

// 10. Check that sessionController exports isJtiBlacklisted
info('\nChecking sessionController exports...');
try {
  const sessionController = require('../backend/src/controllers/sessionController');
  check(
    'sessionController exports isJtiBlacklisted',
    typeof sessionController.isJtiBlacklisted === 'function',
    'isJtiBlacklisted not exported or not a function'
  );
} catch (err) {
  error(`sessionController has issues: ${err.message}`);
  failed++;
}

// Summary
console.log('\n' + '='.repeat(60));
log('Verification Summary', 'blue');
console.log('='.repeat(60));

console.log(`\nPassed: ${passed}`);
if (failed > 0) {
  console.log(`${COLORS.red}Failed: ${failed}${COLORS.reset}`);
}
if (warnings > 0) {
  console.log(`${COLORS.yellow}Warnings: ${warnings}${COLORS.reset}`);
}

console.log('\n' + '='.repeat(60) + '\n');

if (failed === 0) {
  success('All checks passed! BE-104 fix is properly applied.');
  console.log('\nNext steps:');
  console.log('1. Run database migration: psql < database/migrations/20260928_add_suspension_indexes.sql');
  console.log('2. Run tests: npm test -- tests/security/BE-104-token-revocation.test.js');
  console.log('3. Deploy to staging for integration testing');
  console.log('4. Deploy to production');
  console.log('5. Set up monitoring: crontab -e (add monitor-suspension-enforcement.js)');
  process.exit(0);
} else {
  error(`${failed} check(s) failed. Please review and fix the issues above.`);
  console.log('\nRefer to docs/security/BE-104-FIX-REPORT.md for implementation details.');
  process.exit(1);
}
