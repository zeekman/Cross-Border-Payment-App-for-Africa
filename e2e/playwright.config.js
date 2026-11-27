const { defineConfig, devices } = require('@playwright/test');

/**
 * @see https://playwright.dev/docs/test-configuration
 */
module.exports = defineConfig({
  testDir: './tests',
  // Smoke suite plus one spec per step-up money flow (FE-219). Each money-flow
  // spec registers, verifies, sets a PIN, funds via /dev/fund-wallet and then
  // exercises the flow against the real backend, asserting the step-up and
  // idempotency headers on every money POST.
  testMatch: [
    'smoke.spec.js',
    'money-flow-send.spec.js',
    'money-flow-path-send.spec.js',
    'money-flow-swap.spec.js',
    'money-flow-escrow.spec.js',
    'money-flow-batch.spec.js',
    'money-flow-savings.spec.js',
    'money-flow-scheduled.spec.js',
  ],
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ['html'],
    ['junit', { outputFile: 'test-results/junit.xml' }]
  ],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    
    /* Collect trace on the first retry locally; always record on CI so a trace
       is uploaded for every failing test. See https://playwright.dev/docs/trace-viewer */
    trace: process.env.CI ? 'on' : 'on-first-retry',
    
    /* Take screenshot on failure */
    screenshot: 'only-on-failure',
    
    /* Record video on failure */
    video: 'retain-on-failure',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

  ].concat(process.env.E2E_ALL_BROWSERS ? [
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },

    /* Test against mobile viewports. */
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    }
  ] : []),

  /* Run your local dev server before starting the tests */
  webServer: [
    {
      command: 'npm run dev',
      cwd: '../backend',
      port: 5000,
      reuseExistingServer: !process.env.CI,
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.E2E_DATABASE_URL || 'postgresql://postgres:password@localhost:5432/cbpa_test',
        // 'mock' keeps CI hermetic; set E2E_STELLAR_NETWORK=testnet to run
        // against the real testnet horizon (docker-compose services).
        STELLAR_NETWORK: process.env.E2E_STELLAR_NETWORK || 'mock',
        STELLAR_HORIZON_URL: process.env.E2E_STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
        JWT_SECRET: 'test-jwt-secret-key-for-e2e-tests',
        FRONTEND_URL: process.env.E2E_BASE_URL || 'http://localhost:3000',
        EMAIL_ENABLED: 'false',
        // Test mode lets the verify step bypass email confirmation.
        E2E_TEST_MODE: 'true',
        REDIS_URL: process.env.E2E_REDIS_URL || 'redis://localhost:6379/1'
      }
    },
    {
      command: 'npm start',
      cwd: '../frontend',
      port: 3000,
      reuseExistingServer: !process.env.CI,
      timeout: 180000,
      env: {
        BROWSER: 'none',
        PORT: '3000',
        REACT_APP_API_URL: process.env.E2E_API_URL || 'http://localhost:5000/api',
        REACT_APP_STELLAR_NETWORK: process.env.E2E_STELLAR_NETWORK || 'mock'
      }
    }
  ],

  /* Global setup and teardown */
  globalSetup: require.resolve('./global-setup.js'),
  globalTeardown: require.resolve('./global-teardown.js'),
});