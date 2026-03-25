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

validateEnv();

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(compression({ threshold: 1024 }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many auth attempts, please try again later.' },
});

app.use('/api', limiter);
app.use('/api/auth', authLimiter);

app.use("/api/auth", authRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/kyc", kycRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/webhooks", webhookRoutes);

app.get('/health', (req, res) =>
  res.json({ status: 'ok', network: process.env.STELLAR_NETWORK || 'testnet' })
);

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});
require('dotenv').config();
const validateEnv = require('./utils/validateEnv');
const logger = require('./utils/logger');

validateEnv();

const app = require('./app');

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => logger.info(`Server running on port ${PORT}`, { port: PORT }));
