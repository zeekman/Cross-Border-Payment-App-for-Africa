const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const Sentry = require('@sentry/node');

const requestId = require('./middleware/requestId');
const metricsMiddleware = require('./middleware/metricsMiddleware');
const errorHandler = require('./middleware/errorHandler');
const { registry } = require('./utils/metrics');
const rateLimit = require('express-rate-limit');
const rateLimiters = require('./middleware/rateLimiter');

const { getHealth: getLedgerHealth } = require('./services/ledgerListener');

const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const paymentRoutes = require('./routes/payments');
const paymentRequestRoutes = require('./routes/paymentRequests');
const scheduledPaymentRoutes = require('./routes/scheduledPayments');
const savingsRoutes = require('./routes/savings');
const anchorRoutes = require('./routes/anchor');
const kycRoutes = require('./routes/kyc');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhooks');
const toolsRoutes = require('./routes/tools');
const assetsRoutes = require('./routes/assets');
const notificationRoutes = require('./routes/notifications');
const sep10Routes = require('./routes/sep10');
const sep31Routes = require('./routes/sep31');
const devRoutes = require('./routes/dev');
const stellarTomlRoutes = require('./routes/stellarToml');
const analyticsRoutes = require('./routes/analytics');
const dexRoutes = require('./routes/dex');
const supportRoutes = require('./routes/support');
const agentEscrowRoutes = require('./routes/agentEscrow');
const referralRoutes = require('./routes/referrals');
const loyaltyRoutes = require('./routes/loyalty');
const disputeRoutes = require('./routes/disputes');
const pricesRoutes = require('./routes/prices');
const channelsRoutes = require('./routes/channels');
const contractsRoutes = require('./routes/contracts');
const ledgerRoutes = require('./routes/ledger');
const contactsRoutes = require('./routes/contacts');
const ipAllowlist = require('./middleware/ipAllowlist');
const geoRestriction = require('./middleware/geoRestriction');

const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const paymentSendValidators = require('./validators/paymentSendValidators');

const logger = require('./utils/logger');
const { resolveTrustProxy } = require('./utils/trustProxy');
const { runHealthChecks, runDeepHealthChecks } = require('./services/health');

const app = express();
// req.ip drives rate limiting, the admin IP allow-list and geo-restriction,
// so only TRUSTED_PROXIES controls which hops may set X-Forwarded-For.
app.set('trust proxy', resolveTrustProxy(process.env, logger));

// Sentry v8 removed the v7 `Sentry.Handlers` namespace. Request isolation is
// handled by `Sentry.init()` and errors are captured via
// `Sentry.setupExpressErrorHandler(app)` registered after all routes below.

app.use(requestId);
app.use((req, res, next) => {
  req.logger = logger.child({ requestId: req.requestId });
  next();
});
app.use(metricsMiddleware);
app.use(cookieParser());
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

// Helmet is instantiated once at startup. The per-request CSP nonce is supplied
// via a directive function that reads res.locals.cspNonce at request time.
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
      connectSrc: ["'self'", 'https://horizon.stellar.org', 'wss://horizon.stellar.org'],
      imgSrc: ["'self'", 'data:'],
      frameAncestors: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
});
app.use(helmetMiddleware);

// Helmet 8 has no `permissionsPolicy` option, so emit the header explicitly.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true, maxAge: 86400 }));
app.use(express.json());

app.use((req, res, next) => {
  res.removeHeader('Server');
  next();
});

// Serve uploaded avatars after the security middleware so responses carry
// nosniff, CSP and Cross-Origin-Resource-Policy headers.
const path = require('path');
app.use('/uploads/avatars', express.static(path.join(__dirname, '../uploads/avatars'), {
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
  },
}));

// Granular per-endpoint rate limiting (Redis-backed when REDIS_URL is set)
app.use('/api/auth/login', rateLimiters.authLimiter);
app.use('/api/auth/register', rateLimiters.authLimiter);

app.use('/api/auth', authRoutes);
// Authenticated wallet/payment data must never be cached (FE-162)
app.use(['/api/wallet', '/api/payments'], (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
// Deprecated alias for /api/contacts (BE-188) — same router and middleware stack.
const CONTACTS_SUNSET = 'Wed, 31 Mar 2027 00:00:00 GMT';
app.use('/api/wallet/contacts', (req, res, next) => {
  res.set('Deprecation', 'true');
  res.set('Sunset', CONTACTS_SUNSET);
  res.set('Link', '</api/contacts>; rel="successor-version"');
  next();
}, contactsRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/wallet', geoRestriction, walletRoutes);
app.use('/api/payments', geoRestriction, paymentRoutes);
app.use('/api/payment-requests', geoRestriction, paymentRequestRoutes);
app.use('/api/scheduled-payments', geoRestriction, scheduledPaymentRoutes);
app.use('/api/savings', geoRestriction, savingsRoutes);
app.use('/api/anchor', geoRestriction, anchorRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/dex', geoRestriction, dexRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/escrow', geoRestriction, agentEscrowRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/loyalty', loyaltyRoutes);
app.use('/api/disputes', disputeRoutes);
app.use('/api/kyc', kycRoutes);
app.use('/api/admin', ipAllowlist, adminRoutes);
app.use('/api/prices', pricesRoutes);
app.use('/api/channels', geoRestriction, channelsRoutes);
app.use('/api/contracts', contractsRoutes);
app.use('/api/ledger', ledgerRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/tools', toolsRoutes);
app.use('/api/assets', assetsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/.well-known/stellar', sep10Routes);
app.use('/api/sep10', sep10Routes);
app.use('/api/sep31', geoRestriction, sep31Routes);
// BE-031: /api/dev is reserved exclusively for the env-gated developer router
// below. A "legacy alias" that also mounted toolsRoutes at /api/dev used to
// live here (removed) — its naming collision with this router was flagged as
// a production-exposure risk: a future refactor reordering these two
// app.use('/api/dev', ...) calls could accidentally make dev-only tooling
// reachable in production. devRoutes is defense-in-depth gated twice: once
// here (NODE_ENV !== 'production') and again inside routes/dev.js itself
// (NODE_ENV !== 'development'), so it is a 404 in any non-development env.
if (process.env.NODE_ENV !== 'production') {
  app.use('/api/dev', devRoutes);
}
app.use('/', stellarTomlRoutes);

// Sentry v8: register the Express error handler after all routes so thrown
// route errors are reported. No-op when Sentry was not initialized (no DSN).
Sentry.setupExpressErrorHandler(app);

// Swagger API Documentation
const swaggerOptions = {
  definition: {
    openapi: '3.1.0',
    info: {
      title: 'AfriPay API',
      version: '1.0.0',
      description: 'Cross-Border Payment App API on Stellar Network. Authenticated with JWT Bearer tokens.',
      contact: {
        name: 'AfriPay API Support',
        email: 'support@afripay.app'
      }
    },
    servers: [
      {
        url: `${process.env.NODE_ENV === 'production' ? 'https' : 'http'}://${process.env.HOST || 'localhost:5000'}`,
        description: 'Development/Production server'
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error

/* … truncated 587 chars — edit only what you need near the top … */
