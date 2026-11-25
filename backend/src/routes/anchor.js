const express = require('express');
const auth = require('../middleware/auth');
const {
  deposit,
  withdraw,
  status,
  depositValidation,
  withdrawValidation,
  transactionIdValidation,
} = require('../controllers/anchorController');

const router = express.Router();

/**
 * @openapi
 * tags:
 *   - name: Anchor
 *     description: SEP-24 interactive deposit and withdrawal flows
 */

/**
 * @openapi
 * /api/anchor/deposit:
 *   post:
 *     summary: Initiate a SEP-24 interactive deposit
 *     description: >
 *       Starts a SEP-24 interactive deposit with the configured anchor.
 *       Returns a `url` that the frontend must open in a popup or iframe so the
 *       user can complete the anchor's KYC / payment form.
 *       Requires a valid app JWT in `Authorization: Bearer <token>`.
 *       For production, also send the SEP-10 anchor JWT in `X-Sep10-Token`.
 *     tags: [Anchor]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [asset]
 *             properties:
 *               asset:
 *                 type: string
 *                 description: Stellar asset code (e.g. USDC, AFRI)
 *                 example: USDC
 *               amount:
 *                 type: number
 *                 description: Optional deposit amount hint
 *                 example: 100
 *               memo:
 *                 type: string
 *                 description: Optional memo to attach to the deposit
 *                 example: invoice-42
 *     responses:
 *       200:
 *         description: Interactive deposit URL returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:
 *                   type: string
 *                   description: Anchor interactive URL — open this in a popup
 *                 id:
 *                   type: string
 *                   description: Anchor transaction ID for status polling
 *                 message:
 *                   type: string
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Wallet not found
 *       502:
 *         description: Anchor returned an invalid or disallowed URL
 */
router.post('/deposit', auth, depositValidation, deposit);

/**
 * @openapi
 * /api/anchor/withdraw:
 *   post:
 *     summary: Initiate a SEP-24 interactive withdrawal
 *     description: >
 *       Starts a SEP-24 interactive withdrawal with the configured anchor.
 *       Returns a `url` that the frontend must open in a popup or iframe.
 *       Requires a valid app JWT in `Authorization: Bearer <token>`.
 *       For production, also send the SEP-10 anchor JWT in `X-Sep10-Token`.
 *     tags: [Anchor]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [asset]
 *             properties:
 *               asset:
 *                 type: string
 *                 description: Stellar asset code (e.g. USDC, AFRI)
 *                 example: USDC
 *               amount:
 *                 type: number
 *                 description: Optional withdrawal amount hint
 *                 example: 50
 *               dest:
 *                 type: string
 *                 description: Destination bank account / mobile money number
 *               dest_extra:
 *                 type: string
 *                 description: Extra routing info (bank code, branch, etc.)
 *     responses:
 *       200:
 *         description: Interactive withdrawal URL returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:
 *                   type: string
 *                 id:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Validation error
 *       404:
 *         description: Wallet not found
 *       502:
 *         description: Anchor returned an invalid or disallowed URL
 */
router.post('/withdraw', auth, withdrawValidation, withdraw);

/**
 * @openapi
 * /api/anchor/transaction/{id}:
 *   get:
 *     summary: Poll the status of an anchor transaction
 *     description: >
 *       Fetches the current status of a SEP-24 transaction from the anchor.
 *       Users can only query transactions they initiated.
 *     tags: [Anchor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Anchor transaction ID returned by deposit or withdraw
 *     responses:
 *       200:
 *         description: Transaction status object from the anchor
 *       400:
 *         description: Validation error
 *       403:
 *         description: Transaction belongs to a different user
 *       404:
 *         description: Transaction not found
 */
router.get('/transaction/:id', auth, transactionIdValidation, status);

module.exports = router;
