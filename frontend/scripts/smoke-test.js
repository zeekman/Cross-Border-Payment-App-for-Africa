#!/usr/bin/env node
/**
 * Frontend smoke test: verify that every module in src/ passes syntax validation
 * and that the production build completes successfully.
 *
 * This catches:
 * - Parse errors
 * - Import errors
 * - Build-time failures
 * - Missing dependencies
 *
 * The npm run build already runs lint:build (required), so this script primarily
 * ensures the build completes and exits 0.
 *
 * Run with:
 *   node scripts/smoke-test.js
 *
 * Exit codes:
 *   0 = build succeeded
 *   1 = build failed
 */

const { execSync } = require('child_process');
const path = require('path');

function log(msg) {
  console.log(`[frontend-smoke] ${msg}`);
}

log('Running production build (includes lint:build check)');

try {
  // The build script already runs lint:build which catches parse errors and common issues
  // Set required env vars for the build
  const env = {
    ...process.env,
    CI: 'true',
    REACT_APP_API_URL: process.env.REACT_APP_API_URL || 'http://localhost:5000/api',
    REACT_APP_STELLAR_NETWORK: 'testnet',
    // Disable source maps to speed up CI builds
    GENERATE_SOURCEMAP: 'false'
  };
  
  execSync('npm run build', {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
    env
  });
  
  log('✅ Frontend build completed successfully');
  process.exit(0);
} catch (err) {
  console.error('❌ Frontend build failed');
  process.exit(1);
}
