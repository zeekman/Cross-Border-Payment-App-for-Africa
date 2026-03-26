const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const requestId = require('./middleware/requestId');

const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const paymentRoutes = require('./routes/payments');
const kycRoutes = require('./routes/kyc');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhooks');
const notificationRoutes = require('./routes/notifications');
const devRoutes = require('./routes/dev');

const logger = require('./utils/logger');

const app = express();

app.use(requestId);
app.use(cookieParser());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://horizon-testnet.stellar.org', 'https://horizon.stellar.org'],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
    },
  },
}));
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json());

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

app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/kyc', kycRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/dev', devRoutes);

app.get('/health', (req, res) =>
  res.json({ status: 'ok', network: process.env.STELLAR_NETWORK || 'testnet' })
);

app.use((err, req, res, next) => {
  logger.error(err.message, { requestId: req.requestId, stack: err.stack, status: err.status });
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

module.exports = app;
