const { test, expect } = require('@playwright/test');
const { 
  generateTestUser, 
  generateTestAddress, 
  mockStellarAPI,
  waitForAPIResponse 
} = require('../utils/test-helpers');

test.describe('Complete User Journey', () => {
  let testUser;
  let recipientAddress;

  test.beforeEach(async ({ page }) => {
    testUser = generateTestUser();
    recipientAddress = generateTestAddress();
    await mockStellarAPI(page);
  });

  test('complete user journey: register → fund wallet → send payment → view history', async ({ page }) => {
    // Step 1: Register new user
    console.log('Step 1: User Registration');
    await page.goto('/register');
    
    await page.fill('[data-testid="full-name-input"]', testUser.full_name);
    await page.fill('[data-testid="email-input"]', testUser.email);
    await page.fill('[data-testid="password-input"]', testUser.password);
    await page.fill('[data-testid="confirm-password-input"]', testUser.password);
    await page.check('[data-testid="terms-checkbox"]');
    await page.click('[data-testid="register-button"]');
    
    // Verify registration success
    await expect(page.locator('[data-testid="registration-success"]')).toBeVisible();
    
    // Step 2: Login with new account
    console.log('Step 2: User Login');
    await page.click('[data-testid="proceed-to-login"]');
    await expect(page).toHaveURL('/login');
    
    await page.fill('[data-testid="email-input"]', testUser.email);
    await page.fill('[data-testid="password-input"]', testUser.password);
    await page.click('[data-testid="login-button"]');
    
    // Should reach dashboard
    await expect(page).toHaveURL('/dashboard');
    await expect(page.locator('[data-testid="welcome-message"]')).toContainText(testUser.full_name);
    
    // Step 3: Setup PIN for transactions
    console.log('Step 3: PIN Setup');
    await page.goto('/setup-pin');
    await page.fill('[data-testid="pin-input"]', testUser.pin);
    await page.fill('[data-testid="confirm-pin-input"]', testUser.pin);
    await page.click('[data-testid="setup-pin-button"]');
    
    await expect(page.locator('[data-testid="pin-success"]')).toBeVisible();
    
    // Step 4: Check wallet balance (simulated funding)
    console.log('Step 4: Wallet Funding Check');
    await page.goto('/dashboard');
    
    // Verify wallet shows balance (mocked)
    await expect(page.locator('[data-testid="wallet-balance"]')).toBeVisible();
    await expect(page.locator('[data-testid="xlm-balance"]')).toContainText('1000'); // Mocked balance
    await expect(page.locator('[data-testid="usdc-balance"]')).toContainText('500'); // Mocked balance
    
    // Step 5: Send a payment
    console.log('Step 5: Send Payment');
    await page.goto('/send');
    
    // Fill payment form
    await page.fill('[data-testid="recipient-address-input"]', recipientAddress);
    await page.fill('[data-testid="amount-input"]', '50.25');
    await page.selectOption('[data-testid="asset-select"]', 'USDC');
    await page.fill('[data-testid="memo-input"]', 'E2E test payment - full journey');
    
    // Submit payment
    await page.click('[data-testid="send-payment-button"]');
    
    // Confirm with PIN
    await expect(page.locator('[data-testid="pin-modal"]')).toBeVisible();
    await page.fill('[data-testid="pin-confirmation-input"]', testUser.pin);
    await page.click('[data-testid="confirm-pin-button"]');
    
    // Wait for payment processing
    const apiResponse = waitForAPIResponse(page, '/api/payments/send');
    await apiResponse;
    
    // Verify payment success
    await expect(page.locator('[data-testid="payment-success"]')).toBeVisible();
    await expect(page.locator('[data-testid="transaction-hash"]')).toBeVisible();
    
    // Step 6: View transaction history
    console.log('Step 6: Transaction History');
    await page.goto('/history');
    
    // Verify transaction appears in history
    await expect(page.locator('[data-testid="transaction-list"]')).toBeVisible();
    await expect(page.locator('[data-testid="transaction-item"]').first()).toBeVisible();
    
    // Check transaction details
    const firstTransaction = page.locator('[data-testid="transaction-item"]').first();
    await expect(firstTransaction.locator('[data-testid="transaction-amount"]')).toContainText('50.25 USDC');
    await expect(firstTransaction.locator('[data-testid="transaction-type"]')).toContainText('Sent');
    await expect(firstTransaction.locator('[data-testid="transaction-memo"]')).toContainText('E2E test payment - full journey');
    
    // Step 7: View transaction details
    console.log('Step 7: Transaction Details');
    await firstTransaction.click();
    
    // Verify modal opens with full details
    await expect(page.locator('[data-testid="transaction-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="modal-transaction-amount"]')).toContainText('50.25 USDC');
    await expect(page.locator('[data-testid="modal-recipient-address"]')).toContainText(recipientAddress);
    await expect(page.locator('[data-testid="modal-transaction-memo"]')).toContainText('E2E test payment - full journey');
    
    // Close modal
    await page.click('[data-testid="close-modal"]');
    await expect(page.locator('[data-testid="transaction-modal"]')).not.toBeVisible();
    
    // Step 8: Test receive functionality
    console.log('Step 8: Receive Money Setup');
    await page.goto('/receive');
    
    // Verify QR code and address display
    await expect(page.locator('[data-testid="qr-code"]')).toBeVisible();
    await expect(page.locator('[data-testid="stellar-address"]')).toBeVisible();
    
    // Create payment request
    await page.fill('[data-testid="request-amount-input"]', '25.00');
    await page.selectOption('[data-testid="request-asset-select"]', 'XLM');
    await page.fill('[data-testid="request-memo-input"]', 'Payment request from E2E test');
    await page.click('[data-testid="generate-qr-button"]');
    
    // Verify payment request details
    await expect(page.locator('[data-testid="request-details"]')).toBeVisible();
    await expect(page.locator('[data-testid="request-amount"]')).toContainText('25.00 XLM');
    await expect(page.locator('[data-testid="request-memo"]')).toContainText('Payment request from E2E test');
    
    // Step 9: Logout
    console.log('Step 9: User Logout');
    await page.click('[data-testid="user-menu"]');
    await page.click('[data-testid="logout-button"]');
    
    // Verify redirect to login page
    await expect(page).toHaveURL('/login');
    await expect(page.locator('[data-testid="user-menu"]')).not.toBeVisible();
    
    console.log('✅ Complete user journey test passed successfully');
  });

  test('user journey with multiple payments and history filtering', async ({ page }) => {
    // Setup user
    await page.goto('/register');
    await page.fill('[data-testid="full-name-input"]', testUser.full_name);
    await page.fill('[data-testid="email-input"]', testUser.email);
    await page.fill('[data-testid="password-input"]', testUser.password);
    await page.fill('[data-testid="confirm-password-input"]', testUser.password);
    await page.check('[data-testid="terms-checkbox"]');
    await page.click('[data-testid="register-button"]');
    
    await page.click('[data-testid="proceed-to-login"]');
    await page.fill('[data-testid="email-input"]', testUser.email);
    await page.fill('[data-testid="password-input"]', testUser.password);
    await page.click('[data-testid="login-button"]');
    
    // Setup PIN
    await page.goto('/setup-pin');
    await page.fill('[data-testid="pin-input"]', testUser.pin);
    await page.fill('[data-testid="confirm-pin-input"]', testUser.pin);
    await page.click('[data-testid="setup-pin-button"]');
    
    // Send multiple payments
    const payments = [
      { amount: '10.50', asset: 'XLM', memo: 'First payment' },
      { amount: '25.75', asset: 'USDC', memo: 'Second payment' },
      { amount: '5.00', asset: 'XLM', memo: 'Third payment' }
    ];
    
    for (const payment of payments) {
      await page.goto('/send');
      await page.fill('[data-testid="recipient-address-input"]', generateTestAddress());
      await page.fill('[data-testid="amount-input"]', payment.amount);
      await page.selectOption('[data-testid="asset-select"]', payment.asset);
      await page.fill('[data-testid="memo-input"]', payment.memo);
      await page.click('[data-testid="send-payment-button"]');
      
      await page.fill('[data-testid="pin-confirmation-input"]', testUser.pin);
      await page.click('[data-testid="confirm-pin-button"]');
      
      await expect(page.locator('[data-testid="payment-success"]')).toBeVisible();
    }
    
    // Test history filtering
    await page.goto('/history');
    
    // Filter by XLM
    await page.selectOption('[data-testid="asset-filter"]', 'XLM');
    await expect(page.locator('[data-testid="transaction-item"]')).toHaveCount(2); // Should show 2 XLM transactions
    
    // Filter by USDC
    await page.selectOption('[data-testid="asset-filter"]', 'USDC');
    await expect(page.locator('[data-testid="transaction-item"]')).toHaveCount(1); // Should show 1 USDC transaction
    
    // Search by memo
    await page.selectOption('[data-testid="asset-filter"]', 'all');
    await page.fill('[data-testid="transaction-search"]', 'First payment');
    await page.click('[data-testid="search-button"]');
    await expect(page.locator('[data-testid="transaction-item"]')).toHaveCount(1);
    
    console.log('✅ Multiple payments and filtering test passed');
  });

  test('user journey with error handling and recovery', async ({ page }) => {
    // Register and setup user
    await page.goto('/register');
    await page.fill('[data-testid="full-name-input"]', testUser.full_name);
    await page.fill('[data-testid="email-input"]', testUser.email);
    await page.fill('[data-testid="password-input"]', testUser.password);
    await page.fill('[data-testid="confirm-password-input"]', testUser.password);
    await page.check('[data-testid="terms-checkbox"]');
    await page.click('[data-testid="register-button"]');
    
    await page.click('[data-testid="proceed-to-login"]');
    await page.fill('[data-testid="email-input"]', testUser.email);
    await page.fill('[data-testid="password-input"]', testUser.password);
    await page.click('[data-testid="login-button"]');
    
    await page.goto('/setup-pin');
    await page.fill('[data-testid="pin-input"]', testUser.pin);
    await page.fill('[data-testid="confirm-pin-input"]', testUser.pin);
    await page.click('[data-testid="setup-pin-button"]');
    
    // Test payment with insufficient balance
    await page.goto('/send');
    await page.fill('[data-testid="recipient-address-input"]', recipientAddress);
    await page.fill('[data-testid="amount-input"]', '999999'); // More than available
    await page.selectOption('[data-testid="asset-select"]', 'XLM');
    await page.click('[data-testid="send-payment-button"]');
    
    // Should show insufficient balance error
    await expect(page.locator('[data-testid="balance-error"]')).toBeVisible();
    
    // Test payment with invalid address
    await page.fill('[data-testid="recipient-address-input"]', 'invalid-address');
    await page.fill('[data-testid="amount-input"]', '10');
    await page.click('[data-testid="send-payment-button"]');
    
    // Should show address validation error
    await expect(page.locator('[data-testid="address-error"]')).toBeVisible();
    
    // Test successful payment after fixing errors
    await page.fill('[data-testid="recipient-address-input"]', recipientAddress);
    await page.fill('[data-testid="amount-input"]', '15.50');
    await page.click('[data-testid="send-payment-button"]');
    
    await page.fill('[data-testid="pin-confirmation-input"]', testUser.pin);
    await page.click('[data-testid="confirm-pin-button"]');
    
    await expect(page.locator('[data-testid="payment-success"]')).toBeVisible();
    
    // Verify transaction appears in history
    await page.goto('/history');
    await expect(page.locator('[data-testid="transaction-item"]').first()).toBeVisible();
    
    console.log('✅ Error handling and recovery test passed');
  });
});