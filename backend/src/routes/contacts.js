const router = require('express').Router();
const multer = require('multer');
const { body, validationResult } = require('express-validator');
const StellarSdk = require('@stellar/stellar-sdk');
const authMiddleware = require('../middleware/auth');
const {
  getContacts,
  addContact,
  deleteContact,
  importContacts,
  getImportTemplate,
} = require('../controllers/contactsController');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};
const { readLimiter } = require('../middleware/rateLimiter');
const { importContacts, getImportTemplate } = require('../controllers/contactsController');

// ---------------------------------------------------------------------------
// Multer: in-memory storage, CSV files only, 5 MB size limit.
// A single-row CSV with 500 entries is well under 100 KB in practice, so 5 MB
// gives plenty of headroom while preventing accidental large-file uploads.
// ---------------------------------------------------------------------------
const CSV_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CSV_MAX_BYTES },
  fileFilter(req, file, cb) {
    // Accept text/csv or application/vnd.ms-excel (Excel saves .csv with this MIME)
    const allowed = ['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/csv'];
    if (allowed.includes(file.mimetype) || file.originalname.toLowerCase().endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error('Only CSV files are accepted'), { status: 400 }));
    }
  },
});

// Wrap multer so errors surface as 400 JSON instead of 500s
function csvUploadMiddleware(req, res, next) {
  csvUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `CSV file must not exceed ${CSV_MAX_BYTES / 1024 / 1024} MB` });
    }
    return res.status(400).json({ error: err.message || 'File upload error' });
  });
}

router.use(authMiddleware);
router.use(readLimiter);

// CRUD — GET/POST /api/contacts, DELETE /api/contacts/:id
router.get('/', getContacts);
router.post(
  '/',
  [
    body('name')
      .trim()
      .notEmpty()
      .withMessage('Name is required')
      .isLength({ min: 1, max: 100 })
      .withMessage('Name must be between 1 and 100 characters'),
    body('wallet_address')
      .notEmpty()
      .withMessage('Wallet address is required')
      .custom((value) => {
        if (!value.includes('*') && !StellarSdk.StrKey.isValidEd25519PublicKey(value))
          throw new Error('Invalid Stellar wallet address');
        return true;
      }),
    body('notes').optional({ nullable: true }).isLength({ max: 500 }).withMessage('Notes max 500 characters'),
    body('memo_required').optional().isBoolean().withMessage('memo_required must be boolean'),
    body('default_memo').optional({ nullable: true }).isLength({ max: 64 }).withMessage('default_memo max 64 characters'),
    body('tags')
      .optional()
      .isArray()
      .withMessage('tags must be an array')
      .custom((arr) => arr.every((t) => typeof t === 'string' && t.length <= 50))
      .withMessage('Each tag must be a string ≤ 50 chars'),
  ],
  validate,
  addContact,
);
router.delete('/:id', deleteContact);

/**
 * GET /api/contacts/import/template
 * Returns a downloadable CSV template with example rows.
 * Must be registered BEFORE the POST /import route to avoid route shadowing.
 */
router.get('/import/template', getImportTemplate);

/**
 * POST /api/contacts/import
 * Accepts multipart/form-data with a `file` field containing a CSV.
 * Validates all rows, skips duplicates, inserts valid rows in one transaction.
 */
router.post('/import', csvUploadMiddleware, importContacts);

module.exports = router;
