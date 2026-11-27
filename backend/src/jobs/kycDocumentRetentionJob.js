'use strict';

/**
 * BE-225: daily job that deletes KYC documents whose retention period
 * (users.kyc_retain_until = decision date + KYC_RETENTION_YEARS) has passed,
 * and records each deletion in the audit log.
 */

const fs = require('fs');
const db = require('../db');
const audit = require('../services/audit');
const logger = require('../utils/logger');
const { resolveDocumentPath } = require('../utils/kycStorage');

async function runKycDocumentRetention() {
  const { rows } = await db.query(
    `SELECT id, kyc_data FROM users
      WHERE kyc_retain_until IS NOT NULL
        AND kyc_retain_until < NOW()
        AND kyc_document_deleted_at IS NULL
      LIMIT 500`,
  );

  let deleted = 0;
  for (const user of rows) {
    const filename = user.kyc_data?.document_filename;
    const filePath = resolveDocumentPath(filename);
    try {
      if (filePath) await fs.promises.rm(filePath, { force: true });
      await db.query(
        `UPDATE users
            SET kyc_document_deleted_at = NOW(),
                kyc_data = (COALESCE(kyc_data, '{}'::jsonb) - 'document_filename' - 'document_encryption')
                           || jsonb_build_object('document_deleted', true),
                updated_at = NOW()
          WHERE id = $1`,
        [user.id],
      );
      await audit.log(user.id, 'kyc_document_deleted_retention', null, 'kycDocumentRetentionJob', {
        filename: filename || null,
      });
      deleted += 1;
    } catch (err) {
      logger.error('KYC document retention deletion failed', { userId: user.id, error: err.message });
    }
  }

  if (deleted > 0) logger.info('KYC documents deleted past retention', { count: deleted });
  return { deleted };
}

module.exports = { runKycDocumentRetention };
