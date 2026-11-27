# KYC document encryption & retention (BE-225)

## Encryption at rest
- Every uploaded KYC document is encrypted with a fresh 256-bit data key (AES-256-GCM)
  right after magic-byte validation and malware scanning; the plaintext file is deleted.
- The data key is wrapped with the master key `KYC_ENCRYPTION_KEY` (64-char hex, AES-256-GCM).
- `users.kyc_data.document_encryption` stores `{ algorithm, iv, tag, wrapped_key }`.
- Documents are decrypted only in `GET /api/admin/kyc/:userId/document` (admin + IP allowlist),
  streamed to the response, and every view is written to the audit log.
- Recommended defence in depth: keep `uploads/kyc` on private storage with server-side encryption.

## Retention
- On a KYC decision, `users.kyc_retain_until` = decision date + `KYC_RETENTION_YEARS` (default 5,
  covering AML record-keeping obligations under NDPA / Kenya DPA / Ghana DPA).
- `kycDocumentRetentionJob` (daily, `CRON_KYC_RETENTION`, default `30 2 * * *`) deletes files past
  `kyc_retain_until`, sets `kyc_document_deleted_at`, strips the file reference from `kyc_data`
  and writes a `kyc_document_deleted_retention` audit-log entry.
- On account closure, keep `kyc_retain_until` set so the job removes the document once the
  AML period ends.
