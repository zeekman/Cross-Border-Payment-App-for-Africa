// Mirrors backend/src/middleware/supportUpload.js
export const MAX_FILES = 3;
export const MAX_FILE_SIZE = 5 * 1024 * 1024;
export const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'application/pdf'];

/** Returns an i18n key describing the first problem, or null when the files are acceptable. */
export function validateAttachments(files) {
  if (files.length > MAX_FILES) return 'support.too_many_files';
  if (files.some((f) => !ALLOWED_TYPES.includes(f.type))) return 'support.invalid_file_type';
  if (files.some((f) => f.size > MAX_FILE_SIZE)) return 'support.file_too_large';
  return null;
}
