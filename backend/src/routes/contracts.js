/**
 * Contracts Routes
 * Public endpoints for Soroban contract data and events
 */

const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const { getContractEvents } = require('../jobs/contractEventIndexer');
const authMiddleware = require('../middleware/auth');
const { getContractState } = require('../services/contractState');
const { partialRelease } = require('../controllers/agentEscrowController');

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
 * @param {number} [limit=100] - Number of events to return (max 500)
 * @param {number} [offset=0] - Pagination offset
 * @param {string} [from] - Start date (ISO 8601)
 * @param {string} [to] - End date (ISO 8601)
 */
async function getContractEventsHandler(req, res, next) {
  try {
    const { contractId } = req.params;
    const { eventType, limit, offset, from, to } = req.query;

    if (!contractId.match(/^C[A-Z0-9]{55}$/)) {
      return res.status(400).json({ error: 'Invalid contract ID format' });
    }

    const options = {
      eventType: eventType || null,
      limit: Math.min(parseInt(limit) || 100, 500),
      offset: parseInt(offset) || 0,
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

router.get('/:contractId/events', getContractEventsHandler);

/**
 * GET /api/contracts/:contractId/state
 * BE-219: contract version, admin, paused flag and pending upgrade read via
 * Soroban RPC getters (cached), falling back to indexed events.
 */
async function getContractStateHandler(req, res, next) {
  try {
    const { contractId } = req.params;
    if (!contractId.match(/^C[A-Z0-9]{55}$/)) {
      return res.status(400).json({ error: 'Invalid contract ID format' });
    }
    res.json(await getContractState(contractId));
  } catch (err) {
    next(err);
  }
}

router.get('/:contractId/state', getContractStateHandler);

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
module.exports.getContractStateHandler = getContractStateHandler;
