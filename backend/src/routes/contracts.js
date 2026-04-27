/**
 * Contracts Routes
 * Public endpoints for Soroban contract data and events
 */

const router = require('express').Router();
const { getContractEvents } = require('../jobs/contractEventIndexer');

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

    // Validate contract ID format (Stellar public key starting with C)
    if (!contractId.match(/^C[A-Z0-9]{55}$/)) {
      return res.status(400).json({ error: 'Invalid contract ID format' });
    }

    const options = {
      eventType: eventType || null,
      limit: Math.min(parseInt(limit) || 100, 500),
      offset: parseInt(offset) || 0,
      from: from || null,
      to: to || null
    };

    const result = await getContractEvents(contractId, options);

    res.json({
      contract_id: contractId,
      events: result.events,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      hasMore: (result.offset + result.limit) < result.total
    });
  } catch (err) {
    next(err);
  }
}

router.get('/:contractId/events', getContractEventsHandler);

module.exports = router;
