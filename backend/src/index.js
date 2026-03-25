require('dotenv').config();
const validateEnv = require('./utils/validateEnv');
const logger = require('./utils/logger');

validateEnv();

const webpush = require('web-push');
webpush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL || 'admin@afripay.app'}`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const app = require('./app');
const { initStreams } = require('./services/horizonWorker');

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`, { port: PORT });
  initStreams();
});
