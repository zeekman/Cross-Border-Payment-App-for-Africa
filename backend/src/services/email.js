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

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject,
    html: message
  });
}

module.exports = { sendVerificationEmail, sendExpiryNotification };
