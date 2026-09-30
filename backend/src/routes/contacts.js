const router = require('express').Router();
const multer = require('multer');
const authMiddleware = require('../middleware/auth');
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
