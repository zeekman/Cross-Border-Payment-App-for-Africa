const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const { readLimiter, adminLimiter } = require('../middleware/rateLimiter');
const isAdmin = require('../middleware/isAdmin');
const ipAllowlist = require('../middleware/ipAllowlist');
const { issueTokens } = require('../controllers/assetController');
const {
  getStats,
  getUsers,
  getTransactions,
  getDailyTransactionStats,
  getStellarNetworkStats,
  clawback,
  approveKYC,
  revokeKYC,
  setWalletFlags,
  announceContractUpgrade,
  executeContractUpgrade,
  getContractUpgradeStatus,
  getContractEventsEndpoint,
  getContractEventsGlobalEndpoint,
  indexContractEventsEndpoint,
  getFraudRules,
  createFraudRule,
  updateFraudRule,
  getFraudShadowReport,
  bulkSuspend,
  bulkUnsuspend,
  bulkExport,
  getJobStatus,
  bulkKycUpdate,
  getAuditLogs,
  getGeoDenialsReport,
  overrideAmlFlag,
  getAmlOverrides,
} = require('../controllers/adminController');
const { getDeadLetterNotifications } = require('../controllers/notificationController');
const {
  listConfigs,
  createFeeConfig,
  updateFeeConfig,
  listHistory,
  previewFeeConfigChange,
} = require('../controllers/feeConfigController');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

router.use(ipAllowlist);
router.use(authMiddleware);
router.use(readLimiter);
router.use(isAdmin);

/**
 * @openapi
 * /api/admin/health:
 *   get:
 *     summary: Full health diagnostics (admin only)
 *     description: Returns detailed service health including DB, Stellar, network, and pool stats.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All services healthy
 *       503:
 *         description: One or more services degraded
 *       403:
 *         description: Admin access required
 */
router.get('/health', async (req, res) => {
  const { runHealthChecks } = require('../services/health');
  try {
    const body = await runHealthChecks();
    res.status(body.status === 'ok' ? 200 : 503).json(body);
  } catch {
    res.status(503).json({ status: 'degraded', db: 'down', stellar: 'down' });
  }
});

router.get('/stats', getStats);
router.get('/daily-stats', getDailyTransactionStats);
router.get('/users', getUsers);
router.get('/transactions', getTransactions);
router.get('/stellar-stats', getStellarNetworkStats);
router.post('/assets/issue', issueTokens);

router.post('/clawback',
  [
    body('from')
      .notEmpty().withMessage('from address is required')
      .custom((v) => {
        if (!StellarSdk.StrKey.isValidEd25519PublicKey(v)) throw new Error('Invalid Stellar address');
        return true;
      }),
    body('asset').trim().notEmpty().withMessage('asset is required')
      .isIn(['USDC', 'XLM']).withMessage('asset must be USDC or XLM'),
    body('amount').notEmpty().withMessage('amount is required')
      .isFloat({ gt: 0.0000001 }).withMessage('amount must be greater than 0.0000001'),
    body('reason').optional().trim().isLength({ max: 500 }).withMessage('reason must be 500 characters or fewer'),
  ],
  validate,
  clawback
);

router.post('/kyc/:userId/approve', approveKYC);
router.post('/kyc/:userId/revoke', revokeKYC);

router.post(
  '/wallet/:address/set-flags',
  [
    body('set_flags').optional().isInt({ min: 0, max: 15 }).withMessage('set_flags must be 0–15'),
    body('clear_flags').optional().isInt({ min: 0, max: 15 }).withMessage('clear_flags must be 0–15'),
  ],
  validate,
  setWalletFlags,
);

/**
 * Contract Upgrade Routes (Issues #148)
 */
router.post(
  '/contracts/:contractId/upgrade',
  [
    body('wasmHash')
      .notEmpty().withMessage('wasmHash is required')
      .matches(/^[a-f0-9]{64}$/).withMessage('Invalid WASM hash format (must be valid SHA256)'),
    body('description').optional().trim().isLength({ max: 1000 }),
  ],
  validate,
  announceContractUpgrade
);

router.post(
  '/contracts/:contractId/upgrade/execute',
  [
    body('wasmHash')
      .notEmpty().withMessage('wasmHash is required')
      .matches(/^[a-f0-9]{64}$/).withMessage('Invalid WASM hash format'),
  ],
  validate,
  executeContractUpgrade
);

router.get('/contracts/:contractId/upgrade/status', getContractUpgradeStatus);

/**
 * Contract Events Routes (Issue #147, #527)
 */
router.get('/contracts/events', getContractEventsGlobalEndpoint);
router.get('/contracts/:contractId/events', getContractEventsEndpoint);

router.post(
  '/contracts/:contractId/events/index',
  [
    body('contractName').optional().trim().isLength({ max: 100 }),
  ],
  validate,
  indexContractEventsEndpoint
);

// Email queue management (Issue #706)
router.get('/email-queue/stats', async (req, res, next) => {
  try {
    const { getEmailQueue } = require('../services/email');
    const queue = getEmailQueue();
    if (!queue) return res.json({ status: 'disabled', message: 'Email queue not initialized (Redis unavailable)' });
    const [waiting, active, completed, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
    ]);
    res.json({ waiting, active, completed, failed });
  } catch (err) {
    next(err);
  }
});

router.post('/email-queue/retry-failed', async (req, res, next) => {
  try {
    const { getEmailQueue } = require('../services/email');
    const queue = getEmailQueue();
    if (!queue) return res.status(503).json({ error: 'Email queue not initialized' });
    const failedJobs = await queue.getFailed();
    await Promise.all(failedJobs.map((job) => job.retry()));
    res.json({ retried: failedJobs.length });
  } catch (err) {
    next(err);
  }
});
// ---------------------------------------------------------------------------
// Fraud Rule Engine (#690)
// ---------------------------------------------------------------------------
router.get('/fraud-rules', getFraudRules);

router.post('/fraud-rules',
  [
    body('name').trim().notEmpty().isLength({ max: 100 }),
    body('rule_type').isIn(['velocity', 'amount', 'daily_limit']),
    body('parameters').isObject(),
    // BE-033: optional at creation — defaults to 'shadow' in the controller.
    body('mode').optional().isIn(['shadow', 'active']),
  ],
  validate,
  createFraudRule
);

router.patch('/fraud-rules/:id',
  [
    body('name').optional().trim().isLength({ max: 100 }),
    body('parameters').optional().isObject(),
    body('is_active').optional().isBoolean(),
    body('mode').optional().isIn(['shadow', 'active']),
  ],
  validate,
  updateFraudRule
);

// BE-033: compare shadow-rule outcomes (would-block vs would-pass) before
// promoting a rule from 'shadow' to 'active'.
router.get('/fraud-rules/shadow-report', getFraudShadowReport);

// ---------------------------------------------------------------------------
// Bulk User Management (#692)
// ---------------------------------------------------------------------------
router.post('/users/bulk-suspend',
  [
    body('userIds').isArray({ min: 1 }),
    body('reason').optional().trim().isLength({ max: 500 }),
  ],
  validate,
  bulkSuspend
);

router.post('/users/bulk-unsuspend',
  [body('userIds').isArray({ min: 1 })],
  validate,
  bulkUnsuspend
);

router.post('/users/bulk-export',
  [body('userIds').isArray({ min: 1 })],
  validate,
  bulkExport
);

router.post('/users/bulk-kyc-update',
  [
    body('userIds').isArray({ min: 1 }),
    body('status').isIn(['approved', 'rejected']),
    body('reason').optional().trim().isLength({ max: 500 }),
  ],
  validate,
  bulkKycUpdate
);

router.get('/jobs/:jobId', getJobStatus);

// ---------------------------------------------------------------------------
// Dead-letter notifications (#693)
// ---------------------------------------------------------------------------
router.get('/notifications/dead-letter', getDeadLetterNotifications);

// ---------------------------------------------------------------------------
// Immutable Audit Log (#698)
// ---------------------------------------------------------------------------
router.get('/audit-logs', getAuditLogs);
router.get('/compliance/geo-denials', getGeoDenialsReport);

/**
 * @openapi
 * /api/admin/aml/override:
 *   post:
 *     summary: Override an AML flag (admin only, audit-logged) — BE-032
 *     description: >
 *       Requires a mandatory free-text reason. Every override is written to
 *       the audit trail (services/audit.js) with the reviewing admin's
 *       identity and a timestamp for regulatory/compliance traceability.
 *     tags: [Admin, Compliance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Override recorded
 *       400:
 *         description: Missing/empty reason or missing subject
 */
router.post(
  '/aml/override',
  [
    body('reason')
      .isString().withMessage('reason is required')
      .trim()
      .isLength({ min: 1 }).withMessage('reason must not be empty'),
    body('wallet_address').optional().isString().trim(),
    body('user_id').optional().isString().trim(),
    body('new_status').optional().isIn(['cleared', 'confirmed']).withMessage('new_status must be cleared or confirmed'),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  },
  overrideAmlFlag
);

/**
 * @openapi
 * /api/admin/aml/overrides:
 *   get:
 *     summary: Compliance report — list AML overrides in a date range — BE-032
 *     tags: [Admin, Compliance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of overrides
 */
router.get('/aml/overrides', getAmlOverrides);

// ---------------------------------------------------------------------------
// Fee Configuration CRUD with Audit Trail
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/admin/fee-configs:
 *   get:
 *     summary: List all fee configurations (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of fee configurations
 *       403:
 *         description: Admin access required
 */
router.get('/fee-configs', listConfigs);

/**
 * @openapi
 * /api/admin/fee-configs/history:
 *   get:
 *     summary: Get full fee change history (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Full fee change history
 *       403:
 *         description: Admin access required
 */
router.get('/fee-configs/history', listHistory);

/**
 * @openapi
 * /api/admin/fee-configs/preview:
 *   post:
 *     summary: Simulate a proposed fee config against recent transaction volume (admin only)
 *     description: >
 *       Applies a proposed fee config against historical transaction volume
 *       (default last 7 days) and returns the estimated fee-revenue delta
 *       versus what actually happened. Does not modify any data.
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fee_type, asset_code, fee_bps, max_fee_usdc, min_fee_usdc]
 *             properties:
 *               fee_type:
 *                 type: string
 *                 enum: [platform, referral, loyalty_redemption]
 *               asset_code:
 *                 type: string
 *               fee_bps:
 *                 type: integer
 *                 maximum: 1000
 *               max_fee_usdc:
 *                 type: number
 *               min_fee_usdc:
 *                 type: number
 *               lookback_days:
 *                 type: integer
 *                 description: Historical window to simulate against (default 7, max 90)
 *     responses:
 *       200:
 *         description: Simulated fee-revenue delta
 *       400:
 *         description: Validation error
 *       403:
 *         description: Admin access required
 */
router.post(
  '/fee-configs/preview',
  [
    body('fee_type')
      .notEmpty().withMessage('fee_type is required')
      .isIn(['platform', 'referral', 'loyalty_redemption']).withMessage('fee_type must be one of: platform, referral, loyalty_redemption'),
    body('asset_code').notEmpty().withMessage('asset_code is required').trim().isLength({ max: 12 }),
    body('fee_bps')
      .notEmpty().withMessage('fee_bps is required')
      .isInt({ min: 0, max: 1000 }).withMessage('fee_bps must be between 0 and 1000'),
    body('max_fee_usdc').notEmpty().withMessage('max_fee_usdc is required').isFloat({ min: 0 }),
    body('min_fee_usdc').notEmpty().withMessage('min_fee_usdc is required').isFloat({ min: 0 }),
    body('lookback_days').optional().isInt({ min: 1, max: 90 }),
  ],
  validate,
  previewFeeConfigChange
);

/**
 * @openapi
 * /api/admin/fee-configs:
 *   post:
 *     summary: Create a new fee configuration (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fee_type, asset_code, fee_bps, max_fee_usdc, min_fee_usdc]
 *             properties:
 *               fee_type:
 *                 type: string
 *                 enum: [platform, referral, loyalty_redemption]
 *               asset_code:
 *                 type: string
 *               fee_bps:
 *                 type: integer
 *                 maximum: 1000
 *               max_fee_usdc:
 *                 type: number
 *               min_fee_usdc:
 *                 type: number
 *               effective_from:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       201:
 *         description: Fee configuration created
 *       400:
 *         description: Validation error
 *       403:
 *         description: Admin access required
 */
router.post(
  '/fee-configs',
  [
    body('fee_type')
      .notEmpty().withMessage('fee_type is required')
      .isIn(['platform', 'referral', 'loyalty_redemption']).withMessage('fee_type must be one of: platform, referral, loyalty_redemption'),
    body('asset_code').notEmpty().withMessage('asset_code is required').trim().isLength({ max: 12 }),
    body('fee_bps')
      .notEmpty().withMessage('fee_bps is required')
      .isInt({ min: 0, max: 1000 }).withMessage('fee_bps must be between 0 and 1000'),
    body('max_fee_usdc').notEmpty().withMessage('max_fee_usdc is required').isFloat({ min: 0 }),
    body('min_fee_usdc').notEmpty().withMessage('min_fee_usdc is required').isFloat({ min: 0 }),
    body('effective_from').optional().isISO8601().withMessage('effective_from must be a valid ISO 8601 date'),
  ],
  validate,
  createFeeConfig
);

/**
 * @openapi
 * /api/admin/fee-configs/{id}:
 *   patch:
 *     summary: Deactivate current config and create a new active one (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fee_type:
 *                 type: string
 *                 enum: [platform, referral, loyalty_redemption]
 *               asset_code:
 *                 type: string
 *               fee_bps:
 *                 type: integer
 *                 maximum: 1000
 *               max_fee_usdc:
 *                 type: number
 *               min_fee_usdc:
 *                 type: number
 *               effective_from:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Fee configuration updated
 *       400:
 *         description: Validation error
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Fee configuration not found
 */
router.patch(
  '/fee-configs/:id',
  [
    param('id').isInt().withMessage('id must be an integer'),
    body('fee_type').optional().isIn(['platform', 'referral', 'loyalty_redemption']).withMessage('fee_type must be one of: platform, referral, loyalty_redemption'),
    body('asset_code').optional().trim().isLength({ max: 12 }),
    body('fee_bps').optional().isInt({ min: 0, max: 1000 }).withMessage('fee_bps must be between 0 and 1000'),
    body('max_fee_usdc').optional().isFloat({ min: 0 }),
    body('min_fee_usdc').optional().isFloat({ min: 0 }),
    body('effective_from').optional().isISO8601().withMessage('effective_from must be a valid ISO 8601 date'),
  ],
  validate,
  updateFeeConfig
);

module.exports = router;
