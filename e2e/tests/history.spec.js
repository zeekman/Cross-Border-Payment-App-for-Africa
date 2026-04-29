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

test.describe('Transaction History Flow', () => {
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

  test('should display transaction history', async ({ page }) => {
    // Navigate to history page
    await page.goto('/history');
    
    // Verify page elements
    await expect(page.locator('[data-testid="transaction-history"]')).toBeVisible();
    await expect(page.locator('[data-testid="history-title"]')).toContainText('Transaction History');
    
    // Should show empty state initially or loading
    const emptyState = page.locator('[data-testid="empty-history"]');
    const loadingState = page.locator('[data-testid="history-loading"]');
    const transactionList = page.locator('[data-testid="transaction-list"]');
    
    await expect(emptyState.or(loadingState).or(transactionList)).toBeVisible();
  });

  test('should show transaction details in history after sending payment', async ({ page }) => {
    // First send a payment to create history
    await page.goto('/send');
    await page.fill('[data-testid="recipient-address-input"]', recipientAddress);
    await page.fill('[data-testid="amount-input"]', '25.50');
    await page.selectOption('[data-testid="asset-select"]', 'USDC');
    await page.fill('[data-testid="memo-input"]', 'Test payment for history');
    await page.click('[data-testid="send-payment-button"]');
    
    // Confirm payment
    await page.fill('[data-testid="pin-confirmation-input"]', testUser.pin);
    await page.click('[data-testid="confirm-pin-button"]');
    
    // Wait for payment success
    await expect(page.locator('[data-testid="payment-success"]')).toBeVisible();
    
    // Navigate to history
    await page.goto('/history');
    
    // Verify transaction appears in history
    await expect(page.locator('[data-testid="transaction-list"]')).toBeVisible();
    await expect(page.locator('[data-testid="transaction-item"]').first()).toBeVisible();
    
    // Check transaction details
    const firstTransaction = page.locator('[data-testid="transaction-item"]').first();
    await expect(firstTransaction.locator('[data-testid="transaction-amount"]')).toContainText('25.50 USDC');
    await expect(firstTransaction.locator('[data-testid="transaction-type"]')).toContainText('Sent');
    await expect(firstTransaction.locator('[data-testid="transaction-memo"]')).toContainText('Test payment for history');
  });

  test('should filter transactions by type', async ({ page }) => {
    await page.goto('/history');
    
    // Test filter options
    await page.selectOption('[data-testid="transaction-filter"]', 'sent');
    await expect(page.locator('[data-testid="filter-applied"]')).toContainText('Showing sent transactions');
    
    await page.selectOption('[data-testid="transaction-filter"]', 'received');
    await expect(page.locator('[data-testid="filter-applied"]')).toContainText('Showing received transactions');
    
    await page.selectOption('[data-testid="transaction-filter"]', 'all');
    await expect(page.locator('[data-testid="filter-applied"]')).toContainText('Showing all transactions');
  });

  test('should filter transactions by asset type', async ({ page }) => {
    await page.goto('/history');
    
    // Test asset filter
    await page.selectOption('[data-testid="asset-filter"]', 'XLM');
    await expect(page.locator('[data-testid="asset-filter-applied"]')).toContainText('XLM transactions');
    
    await page.selectOption('[data-testid="asset-filter"]', 'USDC');
    await expect(page.locator('[data-testid="asset-filter-applied"]')).toContainText('USDC transactions');
    
    await page.selectOption('[data-testid="asset-filter"]', 'all');
    await expect(page.locator('[data-testid="asset-filter-applied"]')).toContainText('All assets');
  });

  test('should filter transactions by date range', async ({ page }) => {
    await page.goto('/history');
    
    // Set date range filter
    const today = new Date().toISOString().split('T')[0];
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    await page.fill('[data-testid="date-from-input"]', lastWeek);
    await page.fill('[data-testid="date-to-input"]', today);
    await page.click('[data-testid="apply-date-filter"]');
    
    // Verify filter is applied
    await expect(page.locator('[data-testid="date-filter-applied"]')).toBeVisible();
  });

  test('should search transactions by memo or address', async ({ page }) => {
    await page.goto('/history');
    
    // Test search functionality
    await page.fill('[data-testid="transaction-search"]', 'Test payment');
    await page.click('[data-testid="search-button"]');
    
    // Verify search is applied
    await expect(page.locator('[data-testid="search-applied"]')).toContainText('Search: Test payment');
    
    // Clear search
    await page.click('[data-testid="clear-search"]');
    await expect(page.locator('[data-testid="search-applied"]')).not.toBeVisible();
  });

  test('should show transaction details in modal', async ({ page }) => {
    // Mock transaction data
    await page.route('**/api/transactions', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          transactions: [{
            id: 'tx_123',
            hash: 'mock_hash_123',
            type: 'payment',
            amount: '25.50',
            asset: 'USDC',
            from: 'GTEST123SENDER',
            to: recipientAddress,
            memo: 'Test transaction',
            timestamp: new Date().toISOString(),
            status: 'success',
            fee: '0.00001'
          }]
        })
      });
    });
    
    await page.goto('/history');
    
    // Click on transaction to view details
    await page.click('[data-testid="transaction-item"]');
    
    // Verify modal opens with details
    await expect(page.locator('[data-testid="transaction-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="modal-transaction-hash"]')).toContainText('mock_hash_123');
    await expect(page.locator('[data-testid="modal-transaction-amount"]')).toContainText('25.50 USDC');
    await expect(page.locator('[data-testid="modal-transaction-fee"]')).toContainText('0.00001 XLM');
    
    // Close modal
    await page.click('[data-testid="close-modal"]');
    await expect(page.locator('[data-testid="transaction-modal"]')).not.toBeVisible();
  });

  test('should export transaction history', async ({ page }) => {
    await page.goto('/history');
    
    // Click export button
    await page.click('[data-testid="export-history-button"]');
    
    // Verify export options
    await expect(page.locator('[data-testid="export-modal"]')).toBeVisible();
    
    // Test CSV export
    const downloadPromise = page.waitForEvent('download');
    await page.click('[data-testid="export-csv-button"]');
    const download = await downloadPromise;
    
    // Verify download
    expect(download.suggestedFilename()).toContain('transactions');
    expect(download.suggestedFilename()).toContain('.csv');
  });

  test('should paginate through transaction history', async ({ page }) => {
    // Mock large transaction dataset
    await page.route('**/api/transactions*', async route => {
      const url = new URL(route.request().url());
      const page_num = url.searchParams.get('page') || '1';
      
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          transactions: Array.from({ length: 10 }, (_, i) => ({
            id: `tx_${page_num}_${i}`,
            hash: `hash_${page_num}_${i}`,
            type: 'payment',
            amount: '10.00',
            asset: 'XLM',
            timestamp: new Date().toISOString(),
            status: 'success'
          })),
          pagination: {
            page: parseInt(page_num),
            totalPages: 5,
            totalTransactions: 50
          }
        })
      });
    });
    
    await page.goto('/history');
    
    // Verify pagination controls
    await expect(page.locator('[data-testid="pagination"]')).toBeVisible();
    await expect(page.locator('[data-testid="page-info"]')).toContainText('Page 1 of 5');
    
    // Navigate to next page
    await page.click('[data-testid="next-page"]');
    await expect(page.locator('[data-testid="page-info"]')).toContainText('Page 2 of 5');
    
    // Navigate to previous page
    await page.click('[data-testid="prev-page"]');
    await expect(page.locator('[data-testid="page-info"]')).toContainText('Page 1 of 5');
  });

  test('should refresh transaction history', async ({ page }) => {
    await page.goto('/history');
    
    // Click refresh button
    await page.click('[data-testid="refresh-history-button"]');
    
    // Verify loading state
    await expect(page.locator('[data-testid="history-loading"]')).toBeVisible();
    
    // Wait for refresh to complete
    await expect(page.locator('[data-testid="history-loading"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="transaction-history"]')).toBeVisible();
  });

  test('should handle empty transaction history', async ({ page }) => {
    // Mock empty response
    await page.route('**/api/transactions', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          transactions: [],
          pagination: { page: 1, totalPages: 0, totalTransactions: 0 }
        })
      });
    });
    
    await page.goto('/history');
    
    // Verify empty state
    await expect(page.locator('[data-testid="empty-history"]')).toBeVisible();
    await expect(page.locator('[data-testid="empty-history"]')).toContainText('No transactions found');
    await expect(page.locator('[data-testid="start-transaction-button"]')).toBeVisible();
  });

  test('should handle transaction history loading errors', async ({ page }) => {
    // Mock API error
    await page.route('**/api/transactions', async route => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Failed to load transactions' })
      });
    });
    
    await page.goto('/history');
    
    // Verify error state
    await expect(page.locator('[data-testid="history-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="history-error"]')).toContainText('Failed to load transactions');
    
    // Test retry functionality
    await page.click('[data-testid="retry-history-button"]');
    await expect(page.locator('[data-testid="history-loading"]')).toBeVisible();
  });

  test('should show transaction status indicators', async ({ page }) => {
    // Mock transactions with different statuses
    await page.route('**/api/transactions', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          transactions: [
            {
              id: 'tx_success',
              type: 'payment',
              amount: '10.00',
              asset: 'XLM',
              status: 'success',
              timestamp: new Date().toISOString()
            },
            {
              id: 'tx_pending',
              type: 'payment',
              amount: '5.00',
              asset: 'USDC',
              status: 'pending',
              timestamp: new Date().toISOString()
            },
            {
              id: 'tx_failed',
              type: 'payment',
              amount: '15.00',
              asset: 'XLM',
              status: 'failed',
              timestamp: new Date().toISOString()
            }
          ]
        })
      });
    });
    
    await page.goto('/history');
    
    // Verify status indicators
    await expect(page.locator('[data-testid="status-success"]')).toBeVisible();
    await expect(page.locator('[data-testid="status-pending"]')).toBeVisible();
    await expect(page.locator('[data-testid="status-failed"]')).toBeVisible();
  });
});