const logger = require('../utils/logger');
const metrics = require('../utils/metrics');

/**
 * SMS Service for sending OTPs and alerts.
 * Supports Twilio or Africa's Talking via their REST APIs (plain HTTPS with the
 * built-in fetch, so no provider SDK is needed — BE-196).
 */

const SUPPORTED_PROVIDERS = ['twilio', 'africastalking'];

// Masks every run of 4+ digits (OTP codes) down to its last two digits,
// e.g. "123456" -> "****56". Used for any log line that could carry a code.
function maskDigits(text) {
  return String(text).replace(/\d{4,}/g, (m) => '*'.repeat(m.length - 2) + m.slice(-2));
}

// Masks a phone number to its last 4 digits, e.g. "+2348012345678" -> "**********5678".
function maskPhone(phone) {
  const str = String(phone || '');
  if (str.length <= 4) return '****';
  return '*'.repeat(str.length - 4) + str.slice(-4);
}

function recordMetric(provider, status) {
  try {
    metrics.smsSendTotal.inc({ provider, status });
  } catch {}
}

async function sendSMS(to, message) {
  if (!to) {
    logger.warn('SMS target number missing');
    return;
  }

  const provider = process.env.SMS_PROVIDER;

  // Integration point for Twilio or Africa's Talking
  if (provider === 'twilio') {
    return withMetric('twilio', () => sendTwilioSMS(to, message));
  } else if (provider === 'africastalking') {
    return withMetric('africastalking', () => sendAfricaTalkingSMS(to, message));
  }

  // Default: local development mock. Never allowed in production — it would
  // silently drop real OTPs (validateEnv also blocks boot without a provider).
  if (process.env.NODE_ENV === 'production') {
    recordMetric('mock', 'failure');
    logger.error('SMS provider not configured in production; refusing to use mock SMS');
    throw new Error('SMS provider is not configured');
  }
  logger.info(`[MOCK SMS] To: ${maskPhone(to)} | Message: ${maskDigits(message)}`);
  recordMetric('mock', 'success');
  return { success: true, mock: true };
}

async function withMetric(provider, fn) {
  try {
    const result = await fn();
    recordMetric(provider, 'success');
    return result;
  } catch (err) {
    recordMetric(provider, 'failure');
    throw err;
  }
}

async function sendTwilioSMS(to, message) {
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        To: to,
        From: process.env.TWILIO_PHONE_NUMBER,
        Body: message,
      }).toString(),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(`Twilio responded ${res.status}${data.message ? `: ${data.message}` : ''}`);
    }
    return { success: true };
  } catch (err) {
    logger.error('Twilio SMS failed', { error: maskDigits(err.message), to: maskPhone(to) });
    throw new Error('Failed to send SMS via Twilio');
  }
}

async function sendAfricaTalkingSMS(to, message) {
  try {
    const username = process.env.AT_USERNAME;
    const host = username === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
    const params = { username, to, message };
    if (process.env.AT_SENDER_ID) params.from = process.env.AT_SENDER_ID;
    const res = await fetch(`https://${host}/version1/messaging`, {
      method: 'POST',
      headers: {
        apiKey: process.env.AT_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) {
      throw new Error(`Africa's Talking responded ${res.status}`);
    }
    const data = await res.json().catch(() => ({}));
    const recipients = data?.SMSMessageData?.Recipients || [];
    if (recipients.length === 0 || !recipients.some((r) => r.status === 'Success')) {
      const status = recipients[0]?.status || data?.SMSMessageData?.Message || 'no recipients accepted';
      throw new Error(`Africa's Talking rejected message: ${status}`);
    }
    return { success: true };
  } catch (err) {
    logger.error("Africa's Talking SMS failed", { error: maskDigits(err.message), to: maskPhone(to) });
    throw new Error("Failed to send SMS via Africa's Talking");
  }
}

/**
 * Sends a 6-digit verification code.
 */
async function sendOTP(to, code) {
  const message = `Your AfriPay verification code is: ${code}. It expires in 10 minutes.`;
  return sendSMS(to, message);
}

module.exports = { sendSMS, sendOTP, maskDigits, maskPhone, SUPPORTED_PROVIDERS };
