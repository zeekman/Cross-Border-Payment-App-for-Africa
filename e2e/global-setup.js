const { chromium } = require('@playwright/test');
const { execSync } = require('child_process');

async function globalSetup() {
  console.log('🚀 Setting up E2E test environment...');
  
  try {
    // Run database migrations for test database
    console.log('📊 Running database migrations...');
    execSync('npm run migrate', { 
      cwd: '../backend',
      env: {
        ...process.env,
        DATABASE_URL: process.env.E2E_DATABASE_URL || 'postgresql://postgres:password@localhost:5432/cbpa_test'
      },
      stdio: 'inherit'
    });
    
    console.log('✅ E2E test environment setup complete');
  } catch (error) {
    console.error('❌ Failed to setup E2E test environment:', error.message);
    throw error;
  }
}

module.exports = globalSetup;