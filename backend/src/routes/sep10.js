const router = require('express').Router();
const { body, query, validationResult } = require('express-validator');
const { getChallenge, postChallenge } = require('../controllers/sep10Controller');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

/**
 * @openapi
 * /api/sep10/challenge:
 *   get:
 *     summary: SEP-10 — Issue a challenge transaction
 *     description: >
 *       Returns a base64-encoded Stellar transaction that the client must sign
 *       with their keypair and submit to POST /api/sep10/challenge to receive a JWT.
 *     tags: [SEP-10]
 *     parameters:
 *       - in: query
 *         name: account
 *         required: true
 *         schema:
 *           type: string
 *           minLength: 56
 *           maxLength: 56
 *         description: The client's Stellar public key (G…)
 *     responses:
 *       200:
 *         description: Challenge transaction issued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 transaction:
 *                   type: string
 *                   description: Base64-encoded XDR challenge transaction
 *                 network_passphrase:
 *                   type: string
 *       400:
 *         description: Missing or invalid account parameter
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get(
  '/challenge',
  [query('account').isLength({ min: 56, max: 56 }).withMessage('Invalid Stellar account')],
  validate,
  getChallenge
);

/**
 * @openapi
 * /api/sep10/challenge:
 *   post:
 *     summary: SEP-10 — Verify a signed challenge and issue a JWT
 *     description: >
 *       Accepts the challenge transaction signed by the client's keypair.
 *       Verifies both the server and client signatures, then returns a JWT
 *       for use with all authenticated API endpoints.
 *     tags: [SEP-10]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [transaction, network_passphrase]
 *             properties:
 *               transaction:
 *                 type: string
 *                 description: Base64-encoded XDR of the signed challenge transaction
 *               network_passphrase:
 *                 type: string
 *                 description: Must match the server's configured network passphrase
 *     responses:
 *       200:
 *         description: Authentication successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   description: JWT bearer token
 *       400:
 *         description: Invalid transaction, passphrase mismatch, or bad signature
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post(
  '/challenge',
  [body('transaction').notEmpty().withMessage('transaction required')],
  validate,
  postChallenge
);

// Legacy /.well-known/stellar.toml auth endpoints (SEP-10 spec path)
router.get(
  '/auth',
  [query('account').isLength({ min: 56, max: 56 }).withMessage('Invalid Stellar account')],
  validate,
  getChallenge
);

router.post(
  '/auth',
  [body('transaction').notEmpty().withMessage('transaction required')],
  validate,
  postChallenge
);

module.exports = router;
