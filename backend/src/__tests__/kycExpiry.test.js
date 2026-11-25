'use strict';

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));
jest.mock('../services/email', () => ({ sendKycExpiryReminderEmail: jest.fn().mockResolvedValue(undefined) }));

const db = require('../db');
const { sendKycExpiryReminderEmail } = require('../services/email');
const { checkKycDocumentExpiry } = require('../jobs/kycExpiryJob');

const TODAY = new Date().toISOString().slice(0, 10);

beforeEach(() => jest.clearAllMocks());

describe('checkKycDocumentExpiry — expiry marking', () => {
  test('marks expired verified documents and does not send reminders when no upcoming expiries', async () => {
    // First query: UPDATE expired docs
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] }) // expired update
      .mockResolvedValue({ rows: [] });                     // all reminder queries empty

    await checkKycDocumentExpiry();

    // UPDATE must be the first call
    expect(db.query.mock.calls[0][0]).toMatch(/UPDATE users/);
    expect(db.query.mock.calls[0][0]).toMatch(/kyc_status = 'expired'/);
    expect(sendKycExpiryReminderEmail).not.toHaveBeenCalled();
  });

  test('does not mark expiry when no documents have passed their expiry date', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await checkKycDocumentExpiry();

    expect(db.query.mock.calls[0][0]).toMatch(/UPDATE users/);
  });
});

describe('checkKycDocumentExpiry — reminder emails', () => {
  function mockForReminder(daysIndex, userId) {
    // First call: expired update (no rows)
    // Then 3 reminder queries; the one at daysIndex returns a user row
    const calls = [
      { rows: [] }, // expired update
    ];
    for (let i = 0; i < 3; i++) {
      if (i === daysIndex) {
        calls.push({ rows: [{ id: userId, email: 'user@test.com', full_name: 'Test User', kyc_document_expiry_date: new Date(), kyc_reminders_sent: {} }] });
      } else {
        calls.push({ rows: [] });
      }
    }
    // After finding a user: the UPDATE to record reminder sent
    calls.push({ rows: [] });

    let call = 0;
    db.query.mockImplementation(() => Promise.resolve(calls[call++] || { rows: [] }));
  }

  test('sends a 30-day reminder email and records it', async () => {
    mockForReminder(0, 'u-30');

    await checkKycDocumentExpiry();

    expect(sendKycExpiryReminderEmail).toHaveBeenCalledWith('user@test.com', 'Test User', 30);
    // The UPDATE to record the reminder must include today's date
    const updateCall = db.query.mock.calls.find(([sql]) => sql.includes('kyc_reminders_sent = kyc_reminders_sent'));
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toContain(TODAY);
  });

  test('sends a 7-day reminder email', async () => {
    mockForReminder(2, 'u-7');

    await checkKycDocumentExpiry();

    expect(sendKycExpiryReminderEmail).toHaveBeenCalledWith('user@test.com', 'Test User', 7);
  });
});

describe('checkKycDocumentExpiry — idempotency', () => {
  test('does not send duplicate emails when reminder already sent today', async () => {
    const alreadySentUser = {
      id: 'u-dup',
      email: 'dup@test.com',
      full_name: 'Dup User',
      kyc_document_expiry_date: new Date(),
      kyc_reminders_sent: { '30': TODAY }, // already sent today
    };

    db.query
      .mockResolvedValueOnce({ rows: [] })           // expired update
      .mockResolvedValueOnce({ rows: [alreadySentUser] }) // 30-day query
      .mockResolvedValue({ rows: [] });               // 14 and 7-day queries

    await checkKycDocumentExpiry();

    expect(sendKycExpiryReminderEmail).not.toHaveBeenCalled();
  });

  test('sends email again if last reminder was on a different day', async () => {
    const user = {
      id: 'u-prev',
      email: 'prev@test.com',
      full_name: 'Prev User',
      kyc_document_expiry_date: new Date(),
      kyc_reminders_sent: { '30': '2020-01-01' }, // old date
    };

    db.query
      .mockResolvedValueOnce({ rows: [] })        // expired update
      .mockResolvedValueOnce({ rows: [user] })    // 30-day query
      .mockResolvedValueOnce({ rows: [] })        // record update
      .mockResolvedValue({ rows: [] });           // 14 and 7-day queries

    await checkKycDocumentExpiry();

    expect(sendKycExpiryReminderEmail).toHaveBeenCalledWith('prev@test.com', 'Prev User', 30);
  });
});
