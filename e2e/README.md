# End-to-End Tests

This directory contains Playwright end-to-end tests for the Cross-Border Payment App (CBPA). These tests verify complete user journeys and integration between frontend and backend components.

## Test Coverage

The E2E tests cover the following user flows:

### Authentication (`auth.spec.js`)
- User registration with validation
- Login/logout functionality
- Password reset flow
- Session management
- Protected route access

### Send Payment (`send.spec.js`)
- XLM and USDC payment sending
- Payment form validation
- PIN confirmation
- Insufficient balance handling
- Payment failure scenarios

### Receive Money (`receive.spec.js`)
- QR code generation and display
- Payment request creation
- Address copying functionality
- Balance display and refresh
- Custom amount requests

### Transaction History (`history.spec.js`)
- Transaction list display
- Filtering by type, asset, and date
- Transaction search functionality
- Pagination through history
- Transaction detail modal
- Export functionality

## Prerequisites

1. **Node.js 18+** - Required for running Playwright
2. **PostgreSQL** - Test database (separate from development)
3. **Redis** - For session management in tests
4. **Backend and Frontend** - Must be available for testing

## Setup

### 1. Install Dependencies

From the project root:
```bash
npm run install:e2e
```

Or from the e2e directory:
```bash
cd e2e
npm ci
npx playwright install
```

### 2. Environment Setup

Create test database:
```sql
CREATE DATABASE cbpa_test;
```

Set environment variables:
```bash
export E2E_DATABASE_URL="postgresql://postgres:password@localhost:5432/cbpa_test"
export E2E_REDIS_URL="redis://localhost:6379/1"
export E2E_BASE_URL="http://localhost:3000"
```

### 3. Database Migration

Run migrations for test database:
```bash
cd backend
DATABASE_URL=$E2E_DATABASE_URL npm run migrate
```

## Running Tests

### Local Development

Run all E2E tests:
```bash
npm run test:e2e
```

Run with browser UI (headed mode):
```bash
npm run test:e2e:headed
```

Run with Playwright UI for debugging:
```bash
npm run test:e2e:ui
```

Run specific test file:
```bash
npx playwright test auth.spec.js
```

Run tests in specific browser:
```bash
npx playwright test --project=chromium
```

### Debug Mode

Run single test in debug mode:
```bash
npx playwright test auth.spec.js --debug
```

### CI Environment

Tests run automatically on pull requests to main branch. The CI pipeline:

1. Sets up PostgreSQL and Redis services
2. Installs all dependencies
3. Runs database migrations
4. Builds the frontend
5. Executes E2E tests
6. Uploads test results and screenshots

## Test Configuration

### Playwright Config (`playwright.config.js`)

- **Base URL**: Configurable via `E2E_BASE_URL` environment variable
- **Browsers**: Chrome, Firefox, Safari, Mobile Chrome, Mobile Safari
- **Retries**: 2 retries on CI, 0 locally
- **Parallel**: Disabled on CI for stability
- **Screenshots**: On failure only
- **Videos**: Retained on failure
- **Traces**: On first retry

### Test Environment

Tests use a separate test database and mock Stellar network calls to avoid:
- Real blockchain transactions
- Network dependencies
- Rate limiting issues
- Mainnet costs

### Mock Configuration

The test helpers (`utils/test-helpers.js`) provide:
- Mock Stellar API responses
- Test user generation
- Authentication helpers
- Screenshot utilities

## Test Data Management

### User Data
- Each test generates unique test users
- Email addresses include timestamps to avoid conflicts
- Passwords and PINs are consistent for reliability

### Stellar Addresses
- Mock testnet addresses are generated
- No real Stellar accounts are created
- All blockchain operations are mocked

### Database Cleanup
- Tests use isolated test database
- Global setup runs migrations
- No explicit cleanup needed between tests

## Debugging Failed Tests

### Screenshots
Failed tests automatically capture screenshots:
```
e2e/test-results/screenshots/
```

### Videos
Test execution videos are saved on failure:
```
e2e/test-results/videos/
```

### Traces
Playwright traces are captured on retry:
```
e2e/test-results/traces/
```

View traces with:
```bash
npx playwright show-trace trace.zip
```

### Test Reports
HTML reports are generated after test runs:
```bash
npx playwright show-report
```

## Best Practices

### Test Isolation
- Each test is independent
- No shared state between tests
- Fresh user accounts per test

### Selectors
- Use `data-testid` attributes for reliable element selection
- Avoid CSS selectors that may change
- Use semantic selectors when possible

### Assertions
- Wait for elements to be visible before interaction
- Use Playwright's auto-waiting features
- Assert on meaningful content, not just presence

### Error Handling
- Tests include negative scenarios
- Network failures are simulated
- Form validation is thoroughly tested

## Maintenance

### Adding New Tests
1. Create test file in `tests/` directory
2. Follow existing naming convention (`*.spec.js`)
3. Use test helpers from `utils/test-helpers.js`
4. Add appropriate `data-testid` attributes to frontend components

### Updating Selectors
When frontend components change:
1. Update `data-testid` attributes
2. Run tests to verify selectors work
3. Update test helpers if needed

### Performance
- Tests run in parallel locally
- Sequential execution on CI for stability
- Mock external services to reduce flakiness
- Use appropriate timeouts for slow operations

## Troubleshooting

### Common Issues

**Tests timeout waiting for elements**
- Check if `data-testid` attributes exist
- Verify backend is running and accessible
- Check database connection and migrations

**Authentication failures**
- Ensure test database is clean
- Verify JWT secrets match between test and backend
- Check user registration flow

**Payment tests fail**
- Verify Stellar mocking is working
- Check PIN setup and confirmation flows
- Ensure test addresses are valid format

**CI failures**
- Check service health (PostgreSQL, Redis)
- Verify environment variables are set
- Review uploaded artifacts for debugging

### Getting Help

1. Check test output and error messages
2. Review screenshots and videos from failed tests
3. Use Playwright's debug mode for step-by-step execution
4. Consult Playwright documentation for advanced debugging