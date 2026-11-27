'use strict';

jest.mock('../db');

const db = require('../db');
const transactionMonitoring = require('../services/transactionMonitoring');

beforeEach(() => jest.clearAllMocks());

test('opens a case with its payment details and configured SLA', async () => {
  db.query.mockResolvedValueOnce({ rows: [{ id: 'case-1', status: 'open', sla_due_at: new Date() }] });

  await transactionMonitoring.openCase({
    userId: '00000000-0000-4000-8000-000000000001',
    senderWallet: 'Gsender',
    recipientWallet: 'Grecipient',
    amount: '25',
    asset: 'USDC',
    source: 'aml',
    reason: 'Screening flagged the wallet',
    slaHours: 12,
  });

  expect(db.query.mock.calls[0][0]).toContain("NOW() + ($12 * INTERVAL '1 hour')");
  expect(db.query.mock.calls[0][1][7]).toBe('aml');
  expect(db.query.mock.calls[0][1][11]).toBe(12);
});

test('requires a reason before recording an analyst disposition', async () => {
  await expect(transactionMonitoring.updateCase('case-1', {
    disposition: 'released',
    reason: '  ',
  })).rejects.toMatchObject({ status: 400 });
  expect(db.query).not.toHaveBeenCalled();
});
