jest.mock('node-cron', () => ({ schedule: jest.fn(), getTasks: jest.fn(() => new Map()) }));
jest.mock('../services/analyticsRefresh', () => ({ refreshDailyAggregates: jest.fn() }));
jest.mock('../jobs/paymentRequestCleanupJob', () => ({ run: jest.fn() }));

const cron = require('node-cron');
const { startScheduler } = require('../scheduler');

describe('scheduler', () => {
  it('registers the payment request cleanup job', () => {
    startScheduler();
    expect(cron.schedule).toHaveBeenCalledWith(
      process.env.PAYMENT_REQUEST_CLEANUP_CRON || '0 * * * *',
      expect.any(Function)
    );
  });
});
