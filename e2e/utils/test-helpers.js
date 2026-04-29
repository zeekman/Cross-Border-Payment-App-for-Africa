const { expect } = require('@playwright/test');

/**
 * Test utilities and helpers for E2E tests
 */

// Mock Stellar SDK for testing
const mockStellarResponses = {
  // Mock successful payment response
  mockPaymentSuccess: {
    hash: 'mock_transaction_hash_123',
    ledger: 12345,
    successful: true,
    fee_charged: '100',
    operation_count: 1
  },
  
  // Mock account info response
  mockAccountInfo: {
    id: 'GTEST123MOCKACCOUNTID456789',
    sequence: '123456789',
    balances: [
      {
        balance: '1000.0000000',
        asset_type: 'native'
      },
      {
        balance: '500.0000000',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
      }
    ]
  }
};

/**
 * Generate test user data
 */
function generateTestUser(suffix = '') {
  const timestamp = Date.now();
  return {
    full_name: `Test User${suffix}`,
    email: `testuser${suffix}${timestamp}@example.com`,
    password: 'TestPassword123!',
    pin: '1234'
  };
}

/**
 * Generate test Stellar addresses (testnet format)
 */
function generateTestAddress() {
  // Generate a mock testnet address for testing
  return 'GTEST' + Math.random().toString(36).substring(2, 50).toUpperCase().padEnd(46, 'A');
}

/**
 * Login helper function
 */
async function loginUser(page, user) {
  await page.goto('/login');
  await page.fill('[data-testid="email-input"]', user.email);
  await page.fill('[data-testid="password-input"]', user.password);
  await page.click('[data-testid="login-button"]');
  
  // Wait for successful login redirect
  await expect(page).toHaveURL('/dashboard');
}

/**
 * Register helper function
 */
async function registerUser(page, user) {
  await page.goto('/register');
  await page.fill('[data-testid="full-name-input"]', user.full_name);
  await page.fill('[data-testid="email-input"]', user.email);
  await page.fill('[data-testid="password-input"]', user.password);
  await page.fill('[data-testid="confirm-password-input"]', user.password);
  await page.click('[data-testid="register-button"]');
  
  // Wait for successful registration
  await expect(page.locator('[data-testid="registration-success"]')).toBeVisible();
}

/**
 * Setup PIN helper function
 */
async function setupPIN(page, pin) {
  await page.goto('/setup-pin');
  await page.fill('[data-testid="pin-input"]', pin);
  await page.fill('[data-testid="confirm-pin-input"]', pin);
  await page.click('[data-testid="setup-pin-button"]');
  
  await expect(page.locator('[data-testid="pin-success"]')).toBeVisible();
}

/**
 * Mock API responses for Stellar operations
 */
async function mockStellarAPI(page) {
  // Mock Stellar Horizon API calls
  await page.route('**/horizon-testnet.stellar.org/**', async route => {
    const url = route.request().url();
    
    if (url.includes('/accounts/')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockStellarResponses.mockAccountInfo)
      });
    } else if (url.includes('/transactions')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockStellarResponses.mockPaymentSuccess)
      });
    } else {
      await route.continue();
    }
  });
}

/**
 * Wait for API response helper
 */
async function waitForAPIResponse(page, endpoint) {
  return page.waitForResponse(response => 
    response.url().includes(endpoint) && response.status() === 200
  );
}

/**
 * Take screenshot with timestamp
 */
async function takeScreenshot(page, name) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  await page.screenshot({ 
    path: `test-results/screenshots/${name}-${timestamp}.png`,
    fullPage: true 
  });
}

module.exports = {
  mockStellarResponses,
  generateTestUser,
  generateTestAddress,
  loginUser,
  registerUser,
  setupPIN,
  mockStellarAPI,
  waitForAPIResponse,
  takeScreenshot
};