const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

async function sendVerificationEmail(email, token) {
  const url = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Verify your AfriPay email',
    html: `<p>Click the link below to verify your email. It expires in 96 hours.</p>
           <a href="${url}">${url}</a>`
  });
}

async function sendExpiryNotification(email, name, recipientWallet, amount, asset, daysLeft, type) {
  const subject = type === 'sender' 
    ? `⚠️ Your claimable balance expires in ${daysLeft} day${daysLeft > 1 ? 's' : ''}`
    : `💰 You have unclaimed funds expiring in ${daysLeft} day${daysLeft > 1 ? 's' : ''}`;

  const message = type === 'sender'
    ? `<p>Hi ${name},</p>
       <p>Your claimable balance of <strong>${amount} ${asset}</strong> sent to <code>${recipientWallet}</code> will expire in <strong>${daysLeft} day${daysLeft > 1 ? 's' : ''}</strong>.</p>
       <p>If the recipient doesn't claim the funds before expiry, they will be automatically returned to your account.</p>
       <p>Transaction details: <a href="${process.env.FRONTEND_URL}/history">View in AfriPay</a></p>`
    : `<p>Hi ${name},</p>
       <p>You have unclaimed funds of <strong>${amount} ${asset}</strong> waiting for you!</p>
       <p>⚠️ These funds will expire in <strong>${daysLeft} day${daysLeft > 1 ? 's' : ''}</strong> if not claimed.</p>
       <p><a href="${process.env.FRONTEND_URL}/dashboard">Claim your funds now</a></p>`;
async function sendPasswordResetEmail(email, token) {
  const url = `${process.env.FRONTEND_URL}/reset-password?token=${encodeURIComponent(token)}`;
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Reset your AfriPay password',
    html: `<p>You requested a password reset. This link expires in 1 hour and can only be used once.</p>
           <a href="${url}">${url}</a>
           <p>If you did not request this, you can ignore this email.</p>`
  });
}

/**
 * Send a transaction receipt email to either the sender or recipient.
 *
 * @param {string} email        - Recipient email address
 * @param {'sent'|'received'}   type - Direction of the transaction
 * @param {object} tx           - Transaction data
 * @param {string} tx.amount
 * @param {string} tx.asset
 * @param {string} tx.senderAddress
 * @param {string} tx.recipientAddress
 * @param {string|null} tx.memo
 * @param {string} tx.txHash
 */
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
          ${isSent ? '💸 Payment Sent' : '💰 Payment Received'}
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

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject,
    html: message
  });
}

module.exports = { sendVerificationEmail, sendExpiryNotification };
    html
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendTransactionEmail };
