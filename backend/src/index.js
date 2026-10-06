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
const { detectTestnetReset, startFallbackDurationMonitor, stopFallbackDurationMonitor } = require('./services/stellar');
const { initEmailQueue, drainEmailQueue } = require('./services/email');
const { startPriceRefreshJob, stopPriceRefreshJob } = require('./services/priceOracle');
const { syncOfferEvents } = require('./jobs/syncOfferEvents');
const ledgerListener = require('./services/ledgerListener');
const { Server: SocketIOServer } = require('socket.io');
const jwt = require('jsonwebtoken');
const { startScheduler, stopScheduler } = require('./scheduler');
const { setSocketIO } = require('./services/notificationInbox');
const { isJtiBlacklisted } = require('./controllers/sessionController');

const PORT = process.env.PORT || 5000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

initEmailQueue();
startPriceRefreshJob();

const server = app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`, { port: PORT });
  // Background workers (Horizon streams, cron scheduler, monitors) never run
  // under Jest: they outlive the test environment and crash the runner.
  if (process.env.NODE_ENV === 'test') return;
  ledgerListener.initStreams();
  startScheduler();
  startFallbackDurationMonitor(); // BE-036: alert if Horizon fallback stays active too long

  // Warn if testnet was reset since last startup
  if (process.env.NODE_ENV !== 'production') {
    detectTestnetReset().then((reset) => {
      if (reset) {
        logger.warn('⚠️  Stellar testnet reset detected at startup. Run POST /api/dev/handle-testnet-reset to recover.');
      }
    }).catch(() => {});
  }
});

// Socket.IO — scoped per authenticated user (JWT-based room)
const io = new SocketIOServer(server, {
  cors: { origin: process.env.FRONTEND_URL, credentials: true },
});

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if JTI is blacklisted (token revoked via session management)
    if (payload.jti) {
      const blacklisted = await isJtiBlacklisted(payload.jti);
      if (blacklisted) {
        return next(new Error('Token has been revoked'));
      }
    }
    
    // Check if user account is suspended
    const { rows } = await db.query(
      'SELECT is_suspended FROM users WHERE id = $1',
      [payload.userId]
    );
    
    if (rows.length === 0) {
      return next(new Error('User not found'));
    }
    
    if (rows[0].is_suspended) {
      return next(new Error('Account suspended'));
    }
    
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
    // Socket may have disconnected while we were querying.
    if (socket.disconnected) return;
    socket.walletKeys = rows.map((r) => r.public_key);
    for (const key of socket.walletKeys) {
      socket.join(key);
      // Ref-counted: streams exist only while a socket for the wallet is connected.
      ledgerListener.acquireAccount(key);
    }
    logger.info('Socket connected', { userId: socket.userId });
  } catch (err) {
    logger.warn('Socket setup error', { error: err.message });
  }

  socket.on('disconnect', () => {
    for (const key of socket.walletKeys || []) ledgerListener.releaseAccount(key);
    socket.walletKeys = [];
    logger.info('Socket disconnected', { userId: socket.userId });
  });
});

ledgerListener.setSocketIO(io);
setSocketIO(io);

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — shutting down gracefully`);

  const forceExit = setTimeout(() => {
    logger.error('Shutdown timeout exceeded — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  // Stop everything that keeps the event loop or connections alive, otherwise
  // server.close() never completes while clients are connected.
  stopScheduler();
  stopPriceRefreshJob();
  stopFallbackDurationMonitor();
  ledgerListener.stopAll();

  // io.close() disconnects all sockets and closes the underlying HTTP server.
  io.close(async () => {
    clearTimeout(forceExit);
    try {
      await drainEmailQueue();
      logger.info('Email queue drained');
    } catch (err) {
      logger.error('Error draining email queue', { message: err.message });
    }
    try {
      await db.pool.end();
      logger.info('DB pool closed');
    } catch (err) {
      logger.error('Error closing DB pool', { message: err.message });
    }
    process.exit(0);
  });
  // Drop idle keep-alive HTTP connections so the server can close promptly.
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  Sentry.captureException(reason);
});
// The process is in an undefined state after an uncaught exception: report,
// flush Sentry, then exit non-zero and let the orchestrator restart us.
process.on('uncaughtException', async (error) => {
  logger.error('Uncaught exception — exiting', { message: error.message, stack: error.stack });
  Sentry.captureException(error);
  try {
    await Sentry.close(2000);
  } catch {}
  process.exit(1);
});

module.exports = { app, server, shutdown };
