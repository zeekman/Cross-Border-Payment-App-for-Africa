const logger = require('../utils/logger');

/**
 * SMS Service for sending OTPs and alerts.
 * Supports Twilio or Africa's Talking.
 */

async function sendSMS(to, message) {
  if (!to) {
    logger.warn('SMS target number missing', { message });
    return;
  }

  // Integration point for Twilio or Africa's Talking
  if (process.env.SMS_PROVIDER === 'twilio') {
    return sendTwilioSMS(to, message);
  } else if (process.env.SMS_PROVIDER === 'africastalking') {
    return sendAfricaTalkingSMS(to, message);
  } else {
    // Default: local development mock
    logger.info(`[MOCK SMS] To: ${to} | Message: ${message}`);
    return { success: true, mock: true };
  }
}

async function sendTwilioSMS(to, message) {
  try {
    const twilio = require('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });
    return { success: true };
  } catch (err) {
    logger.error('Twilio SMS failed', { error: err.message, to });
    throw new Error('Failed to send SMS via Twilio');
  }
}

async function sendAfricaTalkingSMS(to, message) {
  try {
    const africastalking = require('africastalking')({
      apiKey: process.env.AT_API_KEY,
      username: process.env.AT_USERNAME,
    });
    const sms = africastalking.SMS;
    await sms.send({
      to,
      message,
      from: process.env.AT_SENDER_ID || undefined,
    });
    return { success: true };
  } catch (err) {
    logger.error("Africa's Talking SMS failed", { error: err.message, to });
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

module.exports = { sendSMS, sendOTP };
