const client = require('prom-client');

const registry = new client.Registry();

// Default Node.js process metrics (memory, CPU, event loop lag, etc.)
client.collectDefaultMetrics({ register: registry });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [registry],
});

const horizonRequestDuration = new client.Histogram({
  name: 'horizon_request_duration_seconds',
  help: 'Stellar Horizon API call duration in seconds',
  labelNames: ['operation', 'success'],
  buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

const dbQueryDuration = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'PostgreSQL query duration in seconds',
  labelNames: ['success'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [registry],
});

const wsConnections = new client.Gauge({
  name: 'websocket_active_connections',
  help: 'Number of active Horizon WebSocket stream connections',
  registers: [registry],
});

module.exports = {
  registry,
  httpRequestDuration,
  horizonRequestDuration,
  dbQueryDuration,
  wsConnections,
};
