// BE-029: Confirms kycUpload.js and supportUpload.js both delegate content
// validation to the SAME shared backend/src/utils/fileValidation.js helpers
// instead of maintaining their own divergent copies, and exercises that
// shared validator with a parameterized suite so both upload paths are
// covered by identical assertions.
const fs = require('fs');
const os = require('os');
const path = require('path');

const fileValidation = require('../src/utils/fileValidation');
const { matchesMagicBytes } = fileValidation;

// Minimal valid byte signatures for each supported type.
const VALID_BYTES = {
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/gif': Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
  'application/pdf': Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
};

const BOGUS_BYTES = Buffer.from('this is not a real file at all');

function writeTempFile(bytes) {
  const p = path.join(os.tmpdir(), `upload-validation-${Date.now()}-${Math.random()}`);
  fs.writeFileSync(p, bytes);
  return p;
}

describe('kycUpload.js and supportUpload.js reuse the shared fileValidation validator (BE-029)', () => {
  it('both middlewares import matchesMagicBytes, tryClamScan, cleanupFile(s) from the same module', () => {
    const kycSrc = fs.readFileSync(path.join(__dirname, '../src/middleware/kycUpload.js'), 'utf8');
    const supportSrc = fs.readFileSync(path.join(__dirname, '../src/middleware/supportUpload.js'), 'utf8');

    expect(kycSrc).toMatch(/require\(["']\.\.\/utils\/fileValidation["']\)/);
    expect(supportSrc).toMatch(/require\(["']\.\.\/utils\/fileValidation["']\)/);

    // Neither middleware should re-implement its own magic-byte signature
    // table or malware-scan call — that logic must live only in fileValidation.js.
    expect(kycSrc).not.toMatch(/MAGIC_SIGNATURES\s*=\s*{/);
    expect(supportSrc).not.toMatch(/MAGIC_SIGNATURES\s*=\s*{/);
    expect(kycSrc).not.toMatch(/require\(["']clamscan["']\)/);
    expect(supportSrc).not.toMatch(/require\(["']clamscan["']\)/);
  });

  // Parameterized: the same shared validator must behave identically
  // regardless of which upload path (KYC or support ticket) invokes it.
  describe.each(['image/jpeg', 'image/png', 'application/pdf'])(
    'shared matchesMagicBytes() for %s (allowed by both KYC and support uploads)',
    (mimeType) => {
      let validPath;
      let bogusPath;

      beforeAll(() => {
        validPath = writeTempFile(VALID_BYTES[mimeType]);
        bogusPath = writeTempFile(BOGUS_BYTES);
      });

      afterAll(() => {
        fileValidation.cleanupFile(validPath);
        fileValidation.cleanupFile(bogusPath);
      });

      it('accepts content whose magic bytes match the declared MIME type', () => {
        expect(matchesMagicBytes(validPath, mimeType)).toBe(true);
      });

      it('rejects content that does not match the declared MIME type', () => {
        expect(matchesMagicBytes(bogusPath, mimeType)).toBe(false);
      });
    }
  );

  it('matchesMagicBytes also validates image/gif, which only supportUpload allows', () => {
    const validPath = writeTempFile(VALID_BYTES['image/gif']);
    const bogusPath = writeTempFile(BOGUS_BYTES);
    try {
      expect(matchesMagicBytes(validPath, 'image/gif')).toBe(true);
      expect(matchesMagicBytes(bogusPath, 'image/gif')).toBe(false);
    } finally {
      fileValidation.cleanupFile(validPath);
      fileValidation.cleanupFile(bogusPath);
    }
  });

  it('tryClamScan degrades to "not infected" (with a warning) when ClamAV is unavailable, for either upload path', async () => {
    const p = writeTempFile(VALID_BYTES['application/pdf']);
    try {
      const result = await fileValidation.tryClamScan(p);
      expect(result).toBe(false);
    } finally {
      fileValidation.cleanupFile(p);
    }
  });
});
