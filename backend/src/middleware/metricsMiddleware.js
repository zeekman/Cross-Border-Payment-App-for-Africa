const { httpRequestDuration } = require('../utils/metrics');

/**
 * Records HTTP request duration.
 * Uses req.route.path when available (e.g. /api/payments/send) to avoid
 * high-cardinality labels from dynamic path segments like user IDs.
 */
module.exports = function metricsMiddleware(req, res, next) {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path || req.path || 'unknown';
    end({ method: req.method, route, status_code: res.statusCode });
  });
  next();
};
