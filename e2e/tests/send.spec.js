const { test, expect } = require('@playwright/test');
const { 
  generateTestUser, 
  generateTestAddress, 
  registerUser, 
  loginUser, 
  setupPIN, 
  mockStellarAPI,
  waitForAPIResponse 
} = require('../utils/test-helpers');

test.describe('Send Payment Flow', () => {
  let testUser;
  let recipientAddress;

  test.beforeEach(async ({ page }) => {
    testUser = generateTestUser();
    recipientAddress = generateTestAddress();
    await mockStellarAPI(page);
    
    // Setup authenticated user
    await registerUser(page, testUser);
    await loginUser(page, testUser);
    await setupPIN(page, testUser.pin);
  });

  test('should send XLM payment successfully', async ({ page }) => {
    // Navigate to send payment page
    await page.goto('/send');
    
    // Fill payment form
    await page.fill('[data-testid="recipient-address-input"]', recipientAddress);
    await page.fill('[data-testid="amount-input"]', '10');
    await page.selectOption('[data-testid="asset-select"]', 'XLM');
    await page.fill('[data-testid="memo-input"]', 'Test payment');
    
    // Submit payment
    await page.click('[data-testid="send-payment-button"]');
    
    // Enter PIN confirmation
    await expect(page.locator('[data-testid="pin-modal"]')).toBeVisible();
    await page.fill('[data-testid="pin-confirmation-input"]', testUser.pin);
    await page.click('[data-testid="confirm-pin-button"]');
    
    // Wait for payment processing
    const apiResponse = waitForAPIResponse(page, '/api/payments/send');
    await apiResponse;
    
    // Verify success message
    await expect(page.locator('[data-testid="payment-success"]')).toBeVisible();
    await expect(page.locator('[data-testid="transaction-hash"]')).toBeVisible();
  });

  test('should send USDC payment successfully', async ({ page }) => {
    await page.goto('/send');
    
    // Fill USDC payment form
    await page.fill('[data-testid="recipient-address-input"]', recipientAddress);
    await page.fill('[data-testid="amount-input"]', '25.50');
    await page.selectOption('[data-testid="asset-select"]', 'USDC');
    await page.fill('[data-testid="memo-input"]', 'USDC test payment');
    
    // Submit payment
    await page.click('[data-testid="send-payment-button"]');
    
    // Confirm with PIN
    await page.fill('[data-testid="pin-confirmation-input"]', testUser.pin);
    await page.click('[data-testid="confirm-pin-button"]');
    
    // Verify success
    await expect(page.locator('[data-testid="payment-success"]')).toBeVisible();
  });

  test('should validate recipient address format', async ({ page }) => {
    await page.goto('/send');
    
    // Enter invalid address
    await page.fill('[data-testid="recipient-address-input"]', 'invalid-address');
    await page.fill('[data-testid="amount-input"]', '10');
    
    // Try to submit
    await page.click('[data-testid="send-payment-button"]');
    
    // Verify validation error
    await expect(page.locator('[data-testid="address-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="address-error"]')).toContainText('Invalid Stellar address');
  });

  test('should validate payment amount', async ({ page }) => {
    await page.goto('/send');
    
    await page.fill('[data-testid="recipient-address-input"]', recipientAddress);
    
    // Test negative amount
    await page.fill('[data-testid="amount-input"]', '-10');
    await page.click('[data-testid="send-payment-button"]');
    await expect(page.locator('[data-testid="amount-error"]')).toContainText('Amount must be positive');
    
    // Test zero amount
    await page.fill('[data-testid="amount-input"]', '0');
    await page.click('[data-testid="send-payment-button"]');
    await expect(page.locator('[data-testid="amount-error"]')).toContainText('Amount must be greater than 0');
    
    // Test excessive decimal places
    await page.fill('[data-testid="amount-input"]', '10.12345678');
    await page.click('[data-testid="send-payment-button"]');
    await expect(page.locator('[data-testid="amount-error"]')).toContainText('Maximum 7 decimal places');
  });

  test('should check insufficient balance', async ({ page }) => {
    await page.goto('/send');
    
    // Try to send more than available balance
    await page.fill('[data-testid="recipient-address-input"]', recipientAddress);
    await page.fill('[data-testid="amount-input"]', '999999');
    await page.selectOption('[data-testid="asset-select"]', 'XLM');
    
    await page.click('[data-testid="send-payment-button"]');
    
    // Verify insufficient balance error
    await expect(page.locator('[data-testid="balance-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="balance-error"]')).toContainText('Insufficient balance');
  });

  test('should handle payment failure gracefully', async ({ page }) => {
    // Mock API to return error
    await page.route('**/api/payments/send', async route => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Payment failed: Network error' })
      });
    });
    
    await page.goto('/send');
    
    // Fill and submit payment
    await page.fill('[data-testid="recipient-address-input"]', recipientAddress);
    await page.fill('[data-testid="amount-input"]', '10');
    await page.click('[data-testid="send-payment-button"]');
    
    // Confirm with PIN
    await page.fill('[data-testid="pin-confirmation-input"]', testUser.pin);
    await page.click('[data-testid="confirm-pin-button"]');
    
    // Verify error handling
    await expect(page.locator('[data-testid="payment-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="payment-error"]')).toContainText('Payment failed');
  });

  test('should cancel payment during PIN confirmation', async ({ page }) => {
    await page.goto('/send');
    
    // Fill payment form
    await page.fill('[data-testid="recipient-address-input"]', recipientAddress);
    await page.fill('[data-testid="amount-input"]', '10');
    await page.click('[data-testid="send-payment-button"]');
    
    // Cancel during PIN confirmation
    await expect(page.locator('[data-testid="pin-modal"]')).toBeVisible();
    await page.click('[data-testid="cancel-pin-button"]');
    
    // Verify modal is closed and no payment was sent
    await expect(page.locator('[data-testid="pin-modal"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="payment-success"]')).not.toBeVisible();
  });
});