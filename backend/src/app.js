const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const Sentry = require('@sentry/node');

const requestId = require('./middleware/requestId');
const metricsMiddleware = require('./middleware/metricsMiddleware');
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
const { runHealthChecks, runDeepHealthChecks } = require('./services/health');

const app = express();
const trustedProxies = (process.env.TRUSTED_PROXIES || '').split(',').map((value) => value.trim()).filter(Boolean);
app.set('trust proxy', trustedProxies.length ? trustedProxies : false);

// Trust the configured number of proxy hops (e.g. TRUST_PROXY=1 behind a single load balancer)
// so req.ip reflects the real client address for the admin IP allow-list and rate limiting.
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(tp) ? parseInt(tp, 10) : tp === 'true' ? true : tp);
}

app.use(Sentry.Handlers.requestHandler());

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
            error: {
              type: 'string'
            },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  msg: { type: 'string' },
                  param: { type: 'string' }
                }
              }
            }
          }
        },
        // Derived directly from the express-validator field spec in
        // validators/paymentSendValidators.js so the docs cannot drift from
        // what the runtime v

/* … truncated 72 chars — edit only what you need near the top … */
