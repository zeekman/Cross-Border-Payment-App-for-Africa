const router = require('express').Router();
const authMiddleware = require('../middleware/auth');
const { summary } = require('../controllers/analyticsController');

/**
 * @swagger
 * /api/analytics/summary:
 *   get:
 *     summary: Get analytics summary
 *     tags: [Analytics]
 *     security:
 *       -
