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

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
