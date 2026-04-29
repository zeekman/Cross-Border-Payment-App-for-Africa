const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const Sentry = require('@sentry/node');

const requestId = require('./middleware/requestId');
const metricsMiddleware = require('./middleware/metricsMiddleware');
const { registry } = require('./utils/metrics');

const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const paymentRoutes = require('./routes/payments');
const paymentRequestRoutes = require('./routes/paymentRequests');
const scheduledPaymentRoutes = require('./routes/scheduledPayments');
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
const ipAllowlist = require('./middleware/ipAllowlist');

const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const logger = require('./utils/logger');
const { runHealthChecks } = require('./services/health');

const app = express();

app.use(Sentry.Handlers.requestHandler());
app.use(requestId);
app.use((req, res, next) => {
  req.logger = logger.child({ requestId: req.requestId });
  next();
});
app.use(metricsMiddleware);
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
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true, maxAge: 86400 }));
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
app.use('/api/payment-requests', paymentRequestRoutes);
app.use('/api/scheduled-payments', scheduledPaymentRoutes);
app.use('/api/anchor', anchorRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/dex', dexRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/escrow', agentEscrowRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/loyalty', loyaltyRoutes);
app.use('/api/disputes', disputeRoutes);
app.use('/api/kyc', kycRoutes);
app.use('/api/admin', ipAllowlist, adminRoutes);
app.use('/api/prices', pricesRoutes);
app.use('/api/channels', channelsRoutes);
app.use('/api/contracts', contractsRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/dev', toolsRoutes);
app.use('/api/assets', assetsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/.well-known/stellar', sep10Routes);
app.use('/api/sep31', sep31Routes);
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
        }
      }
    }
  },
  apis: ['./src/routes/*.js']
};

const specs = swaggerJsdoc(swaggerOptions);

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(specs));

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Public liveness probe
 *     description: Returns the overall status and pool utilization. Use /api/admin/health for full diagnostics.
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Service is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [ok, degraded]
 *                 pool:
 *                   type: object
 *                   properties:
 *                     total: { type: integer }
 *                     idle: { type: integer }
 *                     waiting: { type: integer }
 *       503:
 *         description: Service is degraded
 */
app.get('/health', async (req, res) => {
  try {
    const health = await runHealthChecks();
    res.status(health.status === 'ok' ? 200 : 503).json({
      status: health.status,
      pool: health.pool,
    });
  } catch {
    res.status(503).json({ status: 'degraded' });
  }
});

app.get('/metrics', async (req, res) => {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${token}`) {
      return res.status(401).end();
    }
  }
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

app.use(Sentry.Handlers.errorHandler());

app.use((err, req, res, next) => {
  req.logger.error(err.message, { stack: err.stack, status: err.status });
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

module.exports = app;
