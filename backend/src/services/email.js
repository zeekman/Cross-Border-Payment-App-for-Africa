const nodemailer = require('nodemailer');
const { Queue, Worker } = require('bullmq');
const logger = require('../utils/logger');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

let emailQueue = null;
let emailWorker = null;

const RETRY_DELAYS = [60_000, 300_000, 1_800_000];

function getRedisConnection() {
  if (!process.env.REDIS_URL) return null;
  const { Redis } = require('ioredis');
  return new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
}

function initEmailQueue() {
  const connection = getRedisConnection();
  if (!connection) {
    logger.warn('REDIS_URL not set — email queue disabled, falling back to synchronous send');
    return;
  }

  emailQueue = new Queue('email-queue', {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'custom' },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });

  emailWorker = new Worker(
    'email-queue',
    async (job) => {
      const { to, subject, html } = job.data;
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to,
        subject,
        html,
      });
      logger.info('Email sent', { jobId: job.id, to });
    },
    {
      connection: getRedisConnection(),
      settings: {
        backoffStrategy: (attemptsMade) => RETRY_DELAYS[attemptsMade - 1] ?? 1_800_000,
      },
    }
  );

  emailWorker.on('failed', (job, err) => {
    if (job.attemptsMade >= job.opts.attempts) {
      logger.error('CRITICAL: email job exhausted retries', {
        jobId: job.id,
        to: job.data.to,
        error: err.message,
      });
    }
  });

  logger.info('Email queue initialized');
}

async function enqueueEmail(jobData) {
  if (emailQueue) {
    return emailQueue.add('send', jobData);
  }
  return transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: jobData.to,
    subject: jobData.subject,
    html: jobData.html,
  });
}

async function drainEmailQueue() {
  if (emailWorker) await emailWorker.close();
  if (emailQueue) await emailQueue.close();
}

function getEmailQueue() {
  return emailQueue;
}

async function sendVerificationEmail(email, token) {
  const url = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
  return enqueueEmail({
    to: email,
    subject: 'Verify your AfriPay email',
    html: `<p>Click the link below to verify your email. It expires in 96 hours.</p>
           <a href="${url}">${url}</a>`,
  });
}

async function sendPasswordResetEmail(email, token) {
  const url = `${process.env.FRONTEND_URL}/reset-password?token=${encodeURIComponent(token)}`;
  return enqueueEmail({
    to: email,
    subject: 'Reset your AfriPay password',
    html: `<p>You requested a password reset. This link expires in 1 hour and can only be used once.</p>
           <a href="${url}">${url}</a>
           <p>If you did not request this, you can ignore this email.</p>`,
  });
}

async function sendExpiryNotification(email, name, recipientWallet, amount, asset, daysLeft, type) {
  const subject = type === 'sender'
    ? `Your claimable balance expires in ${daysLeft} day${daysLeft > 1 ? 's' : ''}`
    : `You have unclaimed funds expiring in ${daysLeft} day${daysLeft > 1 ? 's' : ''}`;

  const html = type === 'sender'
    ? `<p>Hi ${name},</p>
       <p>Your claimable balance of <strong>${amount} ${asset}</strong> sent to <code>${recipientWallet}</code> will expire in <strong>${daysLeft} day${daysLeft > 1 ? 's' : ''}</strong>.</p>
       <p>If the recipient doesn't claim the funds before expiry, they will be automatically returned to your account.</p>
       <p><a href="${process.env.FRONTEND_URL}/history">View in AfriPay</a></p>`
    : `<p>Hi ${name},</p>
       <p>You have unclaimed funds of <strong>${amount} ${asset}</strong> waiting for you!</p>
       <p>These funds will expire in <strong>${daysLeft} day${daysLeft > 1 ? 's' : ''}</strong> if not claimed.</p>
       <p><a href="${process.env.FRONTEND_URL}/dashboard">Claim your funds now</a></p>`;

  return enqueueEmail({ to: email, subject, html });
}

async function sendTransactionEmail(email, type, tx) {
  const isSent = type === 'sent';
  const explorerBase =
    process.env.STELLAR_NETWORK === 'mainnet'
      ? 'https://stellar.expert/explorer/public/tx'
      : 'https://stellar.expert/explorer/testnet/tx';

  const explorerUrl = `${explorerBase}/${tx.txHash}`;
  const subject = isSent
    ? `AfriPay: You sent ${tx.amount} ${tx.asset}`
    : `AfriPay: You received ${tx.amount} ${tx.asset}`;
  const counterpartyLabel = isSent ? 'Recipient' : 'Sender';
  const counterpartyAddress = isSent ? tx.recipientAddress : tx.senderAddress;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
      <div style="background:#1a56db;padding:24px 32px;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;margin:0;font-size:22px">
          ${isSent ? 'Payment Sent' : 'Payment Received'}
        </h1>
      </div>
      <div style="background:#f9fafb;padding:32px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb">
        <p style="margin:0 0 24px">
          ${isSent
            ? `Your payment of <strong>${tx.amount} ${tx.asset}</strong> has been sent successfully.`
            : `You have received <strong>${tx.amount} ${tx.asset}</strong>.`}
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr style="border-bottom:1px solid #e5e7eb">
            <td style="padding:10px 0;color:#6b7280;width:40%">Amount</td>
            <td style="padding:10px 0;font-weight:600">${tx.amount} ${tx.asset}</td>
          </tr>
          <tr style="border-bottom:1px solid #e5e7eb">
            <td style="padding:10px 0;color:#6b7280">${counterpartyLabel}</td>
            <td style="padding:10px 0;font-family:monospace;word-break:break-all">${counterpartyAddress}</td>
          </tr>
          ${tx.memo ? `
          <tr style="border-bottom:1px solid #e5e7eb">
            <td style="padding:10px 0;color:#6b7280">Memo</td>
            <td style="padding:10px 0">${tx.memo}</td>
          </tr>` : ''}
          <tr style="border-bottom:1px solid #e5e7eb">
            <td style="padding:10px 0;color:#6b7280">Transaction Hash</td>
            <td style="padding:10px 0;font-family:monospace;font-size:12px;word-break:break-all">${tx.txHash}</td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#6b7280">Explorer</td>
            <td style="padding:10px 0">
              <a href="${explorerUrl}" style="color:#1a56db">View on Stellar Expert</a>
            </td>
          </tr>
        </table>
        <p style="margin:24px 0 0;font-size:12px;color:#9ca3af">
          This is an automated receipt from AfriPay. If you did not initiate this transaction, please contact support immediately.
        </p>
      </div>
    </div>
  `;

  return enqueueEmail({ to: email, subject, html });
}

async function sendPaymentRequestExpiredEmail(email, amount, asset) {
  return enqueueEmail({
    to: email,
    subject: 'Your AfriPay payment request has expired',
    html: `<p>Your payment request for <strong>${amount} ${asset}</strong> has expired and is no longer active.</p>
           <p>You can create a new payment request from your AfriPay dashboard.</p>`,
  });
}

async function sendEmailChangeRequestedNotice(currentEmail, newEmail, ip, userAgent) {
  return enqueueEmail({
    to: currentEmail,
    subject: 'AfriPay: Your account email is being changed',
    html: `<p>A request was made to change the email address on your AfriPay account to <strong>${newEmail}</strong>.</p>
           <p>This change will not take effect until <strong>${newEmail}</strong> is verified — your account still uses this address until then.</p>
           <p>Request details: IP ${ip || 'unknown'}, device: ${userAgent || 'unknown'}.</p>
           <p>If you did not request this change, please contact support immediately and change your password.</p>`,
  });
}

async function sendBackupCodeWarningEmail(email, remaining) {
  return enqueueEmail({
    to: email,
    subject: 'AfriPay: Low 2FA backup codes remaining',
    html: `<p>You only have <strong>${remaining}</strong> backup code${remaining === 1 ? '' : 's'} remaining for your AfriPay account.</p>
           <p>Please regenerate your backup codes from your security settings to avoid being locked out.</p>`,
  });
}

async function sendKycExpiryReminderEmail(email, name, daysRemaining) {
  const subject = `Action required: Your AfriPay identity document expires in ${daysRemaining} day${daysRemaining !== 1 ? 's' : ''}`;
  const html = `
    <p>Hi ${name},</p>
    <p>Your identity document on file with AfriPay will expire in <strong>${daysRemaining} day${daysRemaining !== 1 ? 's' : ''}</strong>.</p>
    <p>To continue using AfriPay without interruption, please re-submit your KYC documents before the expiry date.</p>
    <p><a href="${process.env.FRONTEND_URL}/kyc">Re-verify my identity</a></p>
    <p style="font-size:12px;color:#9ca3af">If you have already re-submitted, you can ignore this reminder.</p>
  `;
  return enqueueEmail({ to: email, subject, html });
}

module.exports = {
  initEmailQueue,
  drainEmailQueue,
  enqueueEmail,
  getEmailQueue,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendExpiryNotification,
  sendTransactionEmail,
  sendPaymentRequestExpiredEmail,
  sendBackupCodeWarningEmail,
  sendKycExpiryReminderEmail,
  sendEmailChangeRequestedNotice,
};
