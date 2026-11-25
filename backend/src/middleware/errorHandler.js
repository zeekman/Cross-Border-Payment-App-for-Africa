const logger = require('../utils/logger');

/**
 * BE-174: final Express error handler.
 *
 * Never leaks internal error details (SQL, Horizon URLs, decryption failures)
 * for 5xx responses — those return a generic message plus the request id, and
 * the full error is logged. Only intentional 4xx errors expose their message.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  (req.logger || logger).error(err.message, { stack: err.stack, status });
  if (status >= 500) {
    return res.status(status).json({ error: 'Internal server error', request_id: req.requestId });
  }
  res.status(status).json({ error: err.message || 'Request failed' });
}

module.exports = errorHandler;
