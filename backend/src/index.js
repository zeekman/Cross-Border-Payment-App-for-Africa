require('dotenv').config();

const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  enabled: !!process.env.SENTRY_DSN,
  beforeSend(event) {
    // Scrub sensitive fields from request body
    if (event.request?.data) {
      const scrubFields = ['password', 'secret', 'privateKey', 'token', 'pin', 'encryptedSecretKey'];
      scrubFields.forEach((f) => {
        if (event.request.data[f]) event.request.data[f] = '[Filtered]';
      });
    }
    // Remove authorization header
    if (event.request?.headers?.authorization) {
      event.request.headers.authorization = '[Filtered]';
    }
    return event;
  },
});

const validateEnv = require('./utils/validateEnv');
const logger = require('./utils/logger');

validateEnv();

// Configure VAPID for Web Push using native service (no external dependency)
const webpush = require('./services/webpush');

const db = require('./db');
const app = require('./app');
const { initStreams } = require('./services/horizonWorker');
const { detectTestnetReset } = require('./services/stellar');
const { syncOfferEvents } = require('./jobs/syncOfferEvents');
const ledgerListener = require('./services/ledgerListener');
const { Server: SocketIOServer } = require('socket.io');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 5000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

const server = app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`, { port: PORT });
  initStreams();

  // Warn if testnet was reset since last startup
  if (process.env.NODE_ENV !== 'production') {
    detectTestnetReset().then((reset) => {
      if (reset) {
        logger.warn('⚠️  Stellar testnet reset detected at startup. Run POST /api/dev/handle-testnet-reset to recover.');
      }
    }).catch(() => {});
  }
  // Sync DEX offer events every 2 minutes
  const OFFER_SYNC_INTERVAL_MS = parseInt(process.env.OFFER_SYNC_INTERVAL_MS || '120000', 10);
  setInterval(() => {
    syncOfferEvents().catch((err) =>
      logger.warn('syncOfferEvents interval error', { error: err.message })
    );
  }, OFFER_SYNC_INTERVAL_MS);
});

// Socket.IO — scoped per authenticated user (JWT-based room)
const io = new SocketIOServer(server, {
  cors: { origin: process.env.FRONTEND_URL, credentials: true },
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = payload.userId;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', async (socket) => {
  try {
    const { rows } = await db.query(
      `SELECT w.public_key FROM wallets w WHERE w.user_id = $1`,
      [socket.userId]
    );
    for (const row of rows) {
      socket.join(row.public_key);
      ledgerListener.startStreamForAccount(row.public_key);
      ledgerListener.startPaymentStream(row.public_key);
    }
    logger.info('Socket connected', { userId: socket.userId });
  } catch (err) {
    logger.warn('Socket setup error', { error: err.message });
  }

  socket.on('disconnect', () => {
    logger.info('Socket disconnected', { userId: socket.userId });
  });
});

ledgerListener.setSocketIO(io);

async function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);

  const forceExit = setTimeout(() => {
    logger.error('Shutdown timeout exceeded — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  server.close(async () => {
    clearTimeout(forceExit);
    try {
      await db.pool.end();
      logger.info('DB pool closed');
    } catch (err) {
      logger.error('Error closing DB pool', { message: err.message });
    }
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  Sentry.captureException(reason);
});
process.on('uncaughtException', (error) => {
  Sentry.captureException(error);
});

module.exports = { app, server, shutdown };
