/**
 * Contracts Routes
 * Public endpoints for Soroban contract data and events
 */

const router = require('express').Router();
const { body, param, query, validationResult } = require('express-validator');
const { getContractEvents } = require('../jobs/contractEventIndexer');
const authMiddleware = require('../middleware/auth');
const { partialRelease } = require('../controllers/agentEscrowController');
const rateLimit = require('express-rate-limit');

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please try again later.' },
});

const knownContractIds = () => new Set(
  (process.env.SOROBAN_CONTRACT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
);

const requireKnownContract = (req, res, next) => {
  if (!/^C[A-Z0-9]{55}$/.test(req.params.contractId)) {
    return res.status(400).json({ error: 'Invalid contract ID format' });
  }
  if (!knownContractIds().has(req.params.contractId)) {
    return res.status(404).json({ error: 'Contract not found' });
  }
  next();
};

const eventsQueryRules = [
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('offset').optional().isInt({ min: 0, max: 10000 }).toInt(),
  query('from').optional().isISO8601(),
  query('to').optional().isISO8601(),
  query('eventType').optional().isString().isLength({ max: 64 }),
];

const STATE_TTL_MS = 30 * 1000;
const stateCache = new Map();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

/**
 * GET /api/contracts/:contractId/events
 * Retrieve indexed contract events with optional filtering.
 * Query params: eventType, limit, offset, from, to
 *
 * @param {string} contractId - The Soroban contract ID
 * @param {string} [eventType] - Filter by event type
 * @param {number} [limit=100] - Number of events to return (1-100)
 * @param {number} [offset=0] - Pagination offset
 * @param {string} [from] - Start date (ISO 8601)
 * @param {string} [to] - End date (ISO 8601)
 */
async function getContractEventsHandler(req, res, next) {
  try {
    const { contractId } = req.params;
    const { eventType, limit, offset, from, to } = req.query;

    const options = {
      eventType: eventType || null,
      limit: limit || 100,
      offset: offset || 0,
      from: from || null,
      to: to || null,
    };

    const result = await getContractEvents(contractId, options);

    res.json({
      contract_id: contractId,
      events: result.events,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      hasMore: result.offset + result.limit < result.total,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/contracts/:contractId/state
 * Public summary of a contract's indexed events, cached for 30 seconds.
 */
async function getContractStateHandler(req, res, next) {
  try {
    const { contractId } = req.params;
    const cached = stateCache.get(contractId);
    if (cached && cached.expires > Date.now()) return res.json(cached.data);

    const { events, total } = await getContractEvents(contractId, { limit: 100, offset: 0 });
    const data = {
      contract_id: contractId,
      total_events: total,
      latest_ledger: events[0] ? events[0].ledger_sequence : null,
      last_event_at: events[0] ? events[0].created_at : null,
    };
    stateCache.set(contractId, { data, expires: Date.now() + STATE_TTL_MS });
    res.json(data);
  } catch (err) {
    next(err);
  }
}

router.get('/:contractId/events', readLimiter, authMiddleware, requireKnownContract, eventsQueryRules, validate, getContractEventsHandler);
router.get('/:contractId/state', readLimiter, requireKnownContract, getContractStateHandler);

/**
 * POST /api/contracts/escrow/:id/partial-release
 * Releases part of a pending agent escrow to the agent (issue #657).
 */
router.post(
  '/escrow/:id/partial-release',
  authMiddleware,
  [
    param('id').isUUID().withMessage('Invalid escrow ID'),
    body('amount').isFloat({ gt: 0 }).withMessage('Amount must be greater than 0'),
  ],
  validate,
  partialRelease
);

module.exports = router;
module.exports._stateCache = stateCache;
