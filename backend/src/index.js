require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const compression = require("compression");

const validateEnv = require("./utils/validateEnv");
const authRoutes = require("./routes/auth");
const walletRoutes = require("./routes/wallet");
const paymentRoutes = require("./routes/payments");
const kycRoutes = require("./routes/kyc");
const adminRoutes = require("./routes/admin");
const webhookRoutes = require("./routes/webhooks");
require('dotenv').config();

const validateEnv = require('./utils/validateEnv');
validateEnv();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const db = require('./db');
const validateEnv = require('./utils/validateEnv');
const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const paymentRoutes = require('./routes/payments');
const kycRoutes = require('./routes/ kyc');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhooks');

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(compression({ threshold: 1024 }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many auth attempts, please try again later.' }
});

app.use('/api', limiter);
app.use('/api/auth', authLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/kyc', kycRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/kyc", kycRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/webhooks", webhookRoutes);

app.get('/health', (req, res) =>
  res.json({ status: 'ok', network: process.env.STELLAR_NETWORK })
);

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});
require('dotenv').config();

const validateEnv = require('./utils/validateEnv');
const logger = require('./utils/logger');

validateEnv();

const webpush = require('web-push');
webpush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL || 'admin@afripay.app'}`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const app = require('./app');
const { initStreams } = require('./services/horizonWorker');

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`, { port: PORT });
  initStreams();
});
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function shutdown(signal) {
  console.log(`${signal} received — shutting down gracefully`);

  const forceExit = setTimeout(() => {
    console.error('Shutdown timeout exceeded — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  server.close(async () => {
    clearTimeout(forceExit);
    try {
      await db.pool.end();
      console.log('DB pool closed');
    } catch (err) {
      console.error('Error closing DB pool:', err.message);
    }
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = { app, server, shutdown };
app.listen(PORT, () => logger.info(`Server running on port ${PORT}`, { port: PORT }));
