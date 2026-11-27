'use strict';

const path = require('path');

// Single source of truth for the KYC upload directory (see kycUpload.js).
const KYC_UPLOAD_DIR = path.resolve(__dirname, '../../../uploads/kyc');

/** AML record-keeping period after a KYC decision (default 5 years). */
function retentionYears() {
  const n = parseInt(process.env.KYC_RETENTION_YEARS || '5', 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/** Resolve a stored document filename to an absolute path inside the upload dir. */
function resolveDocumentPath(filename) {
  if (!filename) return null;
  const resolved = path.resolve(KYC_UPLOAD_DIR, path.basename(String(filename)));
  return resolved.startsWith(KYC_UPLOAD_DIR + path.sep) ? resolved : null;
}

module.exports = { KYC_UPLOAD_DIR, retentionYears, resolveDocumentPath };
