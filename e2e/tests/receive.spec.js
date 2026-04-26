const { test, expect } = require('@playwright/test');
const { 
  generateTestUser, 
  registerUser, 
  loginUser, 
  setupPIN, 
  mockStellarAPI 
} = require('../utils/test-helpers');

test.describe('Receive Money Flow', () => {
  let testUser;

  test.beforeEach(async ({ page }) => {
    testUser = generateTestUser();
    await mockStellarAPI(page);
    
    // Setup authenticated user
    await registerUser(page, testUser);
    await loginUser(page, testUser);
    await setupPIN(page, testUser.pin);
  });

  test('should display QR code for receiving payments', async ({ page }) => {
    // Navigate to receive page
    await page.goto('/receive');
    
    // Verify QR code is displayed
    await expect(page.locator('[data-testid="qr-code"]')).toBeVisible();
    
    // Verify Stellar address is displayed
    await expect(page.locator('[data-testid="stellar-address"]')).toBeVisible();
    await expect(page.locator('[data-testid="stellar-address"]')).toContainText('G');
  });

  test('should copy Stellar address to clipboard', async ({ page }) => {
    await page.goto('/receive');
    
    // Click copy button
    await page.click('[data-testid="copy-address-button"]');
    
    // Verify copy success message
    await expect(page.locator('[data-testid="copy-success"]')).toBeVisible();
    await expect(page.locator('[data-testid="copy-success"]')).toContainText('Address copied');
  });

  test('should generate QR code with custom amount', async ({ page }) => {
    await page.goto('/receive');
    
    // Set custom amount
    await page.fill('[data-testid="request-amount-input"]', '25.50');
    await page.selectOption('[data-testid="request-asset-select"]', 'USDC');
    await page.fill('[data-testid="request-memo-input"]', 'Invoice #123');
    
    // Generate QR code
    await page.click('[data-testid="generate-qr-button"]');
    
    // Verify QR code updates
    await expect(page.locator('[data-testid="qr-code"]')).toBeVisible();
    
    // Verify payment request details are shown
    await expect(page.locator('[data-testid="request-details"]')).toBeVisible();
    await expect(page.locator('[data-testid="request-amount"]')).toContainText('25.50 USDC');
    await expect(page.locator('[data-testid="request-memo"]')).toContainText('Invoice #123');
  });

  test('should share payment request link', async ({ page }) => {
    await page.goto('/receive');
    
    // Set payment request details
    await page.fill('[data-testid="request-amount-input"]', '100');
    await page.selectOption('[data-testid="request-asset-select"]', 'XLM');
    await page.fill('[data-testid="request-memo-input"]', 'Payment request');
    await page.click('[data-testid="generate-qr-button"]');
    
    // Click share button
    await page.click('[data-testid="share-request-button"]');
    
    // Verify share modal or copy success
    const shareModal = page.locator('[data-testid="share-modal"]');
    const copySuccess = page.locator('[data-testid="link-copied"]');
    
    await expect(shareModal.or(copySuccess)).toBeVisible();
  });

  test('should validate payment request amount', async ({ page }) => {
    await page.goto('/receive');
    
    // Test negative amount
    await page.fill('[data-testid="request-amount-input"]', '-10');
    await page.click('[data-testid="generate-qr-button"]');
    await expect(page.locator('[data-testid="request-amount-error"]')).toContainText('Amount must be positive');
    
    // Test zero amount
    await page.fill('[data-testid="request-amount-input"]', '0');
    await page.click('[data-testid="generate-qr-button"]');
    await expect(page.locator('[data-testid="request-amount-error"]')).toContainText('Amount must be greater than 0');
  });

  test('should display wallet balance information', async ({ page }) => {
    await page.goto('/receive');
    
    // Verify balance display
    await expect(page.locator('[data-testid="wallet-balance"]')).toBeVisible();
    await expect(page.locator('[data-testid="xlm-balance"]')).toBeVisible();
    await expect(page.locator('[data-testid="usdc-balance"]')).toBeVisible();
    
    // Verify balance values
    await expect(page.locator('[data-testid="xlm-balance"]')).toContainText('XLM');
    await expect(page.locator('[data-testid="usdc-balance"]')).toContainText('USDC');
  });

  test('should refresh balance when requested', async ({ page }) => {
    await page.goto('/receive');
    
    // Click refresh balance button
    await page.click('[data-testid="refresh-balance-button"]');
    
    // Verify loading state
    await expect(page.locator('[data-testid="balance-loading"]')).toBeVisible();
    
    // Wait for balance to update
    await expect(page.locator('[data-testid="balance-loading"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="wallet-balance"]')).toBeVisible();
  });

  test('should handle QR code generation errors', async ({ page }) => {
    // Mock API error for QR generation
    await page.route('**/api/payments/request', async route => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Failed to generate payment request' })
      });
    });
    
    await page.goto('/receive');
    
    // Try to generate QR with custom amount
    await page.fill('[data-testid="request-amount-input"]', '50');
    await page.click('[data-testid="generate-qr-button"]');
    
    // Verify error handling
    await expect(page.locator('[data-testid="qr-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="qr-error"]')).toContainText('Failed to generate');
  });

  test('should clear payment request form', async ({ page }) => {
    await page.goto('/receive');
    
    // Fill form
    await page.fill('[data-testid="request-amount-input"]', '25');
    await page.selectOption('[data-testid="request-asset-select"]', 'USDC');
    await page.fill('[data-testid="request-memo-input"]', 'Test memo');
    
    // Clear form
    await page.click('[data-testid="clear-request-button"]');
    
    // Verify form is cleared
    await expect(page.locator('[data-testid="request-amount-input"]')).toHaveValue('');
    await expect(page.locator('[data-testid="request-memo-input"]')).toHaveValue('');
    await expect(page.locator('[data-testid="request-asset-select"]')).toHaveValue('XLM');
  });
});