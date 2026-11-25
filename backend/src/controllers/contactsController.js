const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const StellarSdk = require('@stellar/stellar-sdk');

async function getContacts(req, res, next) {
  try {
    const { tag } = req.query;
    let query = 'SELECT id, name, wallet_address, notes, memo_required, default_memo, tags, created_at FROM contacts WHERE user_id = $1';
    const params = [req.user.userId];
    if (tag) {
      query += ' AND $2 = ANY(tags)';
      params.push(tag);
    }
    query += ' ORDER BY name';
    const result = await db.query(query, params);
    res.json({ contacts: result.rows });
  } catch (err) { next(err); }
}

async function addContact(req, res, next) {
  try {
    const { name, wallet_address, notes, memo_required, default_memo, tags } = req.body;
    const id = uuidv4();

    // Upsert: if the same Stellar public key already exists for this user, update
    // the label/metadata rather than creating a duplicate entry.
    // The DB enforces uniqueness via contacts_user_wallet_unique (user_id, wallet_address).
    // Product decision: upsert (merge) — return the updated record with 200 if it
    // already existed, 201 if it was newly created.
    const result = await db.query(
      `INSERT INTO contacts (id, user_id, name, wallet_address, notes, memo_required, default_memo, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id, wallet_address) DO UPDATE
         SET name = EXCLUDED.name,
             notes = EXCLUDED.notes,
             memo_required = EXCLUDED.memo_required,
             default_memo = EXCLUDED.default_memo,
             tags = EXCLUDED.tags
       RETURNING id, name, wallet_address, notes, memo_required, default_memo, tags, (xmax = 0) AS inserted`,
      [id, req.user.userId, name, wallet_address,
       notes || null, memo_required || false, default_memo || null, tags || []]
    );

    const contact = result.rows[0];
    const wasInserted = contact.inserted;
    // Remove the internal flag from the response
    delete contact.inserted;

    const statusCode = wasInserted ? 201 : 200;
    const message = wasInserted ? 'Contact saved' : 'Contact updated';
    res.status(statusCode).json({ message, contact });
  } catch (err) {
    // Safety net: map DB unique-constraint violations to a clear conflict error
    // in case a race bypasses the ON CONFLICT clause (e.g., a different constraint).
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A contact with this Stellar address already exists.' });
    }
    next(err);
  }
}

async function deleteContact(req, res, next) {
  try {
    const result = await db.query(
      'DELETE FROM contacts WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId],
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Contact not found' });
    res.json({ message: 'Contact deleted' });
  } catch (err) { next(err); }
}

// ---------------------------------------------------------------------------
// CSV bulk import limits
// ---------------------------------------------------------------------------
const MAX_IMPORT_ROWS = 500;
const MAX_NAME_LENGTH = 100;

/**
 * GET /api/contacts/import/template
 * Returns a downloadable CSV template with example data.
 */
async function getImportTemplate(req, res) {
  const rows = [
    'name,address,email',
    'Alice Okonkwo,GABCDE...EXAMPLE,alice@example.com',
    'Bob Mensah,GXYZ...EXAMPLE,',
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts_import_template.csv"');
  res.send(rows);
}

/**
 * POST /api/contacts/import
 * Accepts multipart/form-data with a `file` field (CSV).
 *
 * Expected CSV columns: name (required), address (required), email (optional).
 *
 * Rules:
 *  - Max 500 rows per request.
 *  - All rows validated before any insert.
 *  - Duplicate addresses (already in user's contacts) are skipped.
 *  - All valid inserts happen in a single DB transaction;
 *    any unexpected error rolls back the entire batch.
 *
 * Response: { imported, skipped_duplicates, failed, errors: [{row, error}] }
 */
async function importContacts(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file uploaded. Use field name "file".' });
    }

    // Parse CSV from buffer — we avoid external deps and use a hand-rolled parser
    // that handles optional quotes, trims whitespace, and skips blank lines.
    // The parser is quote-aware from the start so that fields containing embedded
    // newlines (RFC 4180) are handled correctly.
    const csvText = req.file.buffer.toString('utf8');

    // Quote-aware line splitter: splits on newlines that are NOT inside
    // double-quoted fields.
    function splitCsvLines(text) {
      const lines = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
          if (inQuotes && text[i + 1] === '"') { current += '"'; i++; }
          else { inQuotes = !inQuotes; }
        } else if ((ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) && !inQuotes) {
          if (ch === '\r') i++; // skip \n after \r
          lines.push(current);
          current = '';
        } else if (ch === '\r' && !inQuotes) {
          lines.push(current);
          current = '';
        } else {
          current += ch;
        }
      }
      if (current !== '' || text.endsWith('\n')) {
        lines.push(current);
      }
      return lines;
    }

    const lines = splitCsvLines(csvText);

    if (lines.length < 2) {
      return res.status(400).json({ error: 'CSV file must contain a header row and at least one data row.' });
    }

    // Parse header — normalise to lowercase, strip BOM
    const headerLine = lines[0].replace(/^\uFEFF/, '').toLowerCase();
    const headers = parseCsvFields(headerLine);

    const nameIdx    = headers.indexOf('name');
    const addressIdx = headers.indexOf('address');
    const emailIdx   = headers.indexOf('email');

    if (nameIdx === -1 || addressIdx === -1) {
      return res.status(400).json({
        error: 'CSV must contain "name" and "address" columns.',
      });
    }

    // Collect data rows (skip blank lines)
    const dataLines = lines.slice(1).filter((l) => l.trim() !== '');

    if (dataLines.length === 0) {
      return res.status(400).json({ error: 'CSV file contains no data rows.' });
    }

    if (dataLines.length > MAX_IMPORT_ROWS) {
      return res.status(400).json({
        error: `Import is limited to ${MAX_IMPORT_ROWS} contacts per request. This file has ${dataLines.length} rows.`,
      });
    }

    // Helper: parse one CSV line into fields respecting double-quoted fields
    function parseCsvFields(line) {
      const fields = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
          else { inQuotes = !inQuotes; }
        } else if (ch === ',' && !inQuotes) {
          fields.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      fields.push(current.trim());
      return fields;
    }

    // Phase 1: validate all rows
    const validRows   = [];   // { name, address, email }
    const errors      = [];   // { row, error }

    for (let i = 0; i < dataLines.length; i++) {
      const rowNum = i + 2; // 1-based, +1 for header
      const fields = parseCsvFields(dataLines[i]);

      const name    = (fields[nameIdx]    || '').trim();
      const address = (fields[addressIdx] || '').trim();
      const email   = emailIdx !== -1 ? (fields[emailIdx] || '').trim() : '';

      if (!name) {
        errors.push({ row: rowNum, error: 'name is required' });
        continue;
      }
      if (name.length > MAX_NAME_LENGTH) {
        errors.push({ row: rowNum, error: `name exceeds ${MAX_NAME_LENGTH} characters` });
        continue;
      }
      if (!address) {
        errors.push({ row: rowNum, error: 'address is required' });
        continue;
      }
      if (!StellarSdk.StrKey.isValidEd25519PublicKey(address)) {
        errors.push({ row: rowNum, error: 'Invalid Stellar address' });
        continue;
      }

      validRows.push({ name, address, email: email || null });
    }

    // Phase 2: check existing contacts for duplicates
    let skippedDuplicates = 0;
    const toInsert = [];

    if (validRows.length > 0) {
      const allAddresses = validRows.map((r) => r.address);
      const existingResult = await db.query(
        'SELECT wallet_address FROM contacts WHERE user_id = $1 AND wallet_address = ANY($2)',
        [req.user.userId, allAddresses]
      );
      const existingSet = new Set(existingResult.rows.map((r) => r.wallet_address));

      for (const row of validRows) {
        if (existingSet.has(row.address)) {
          skippedDuplicates++;
        } else {
          toInsert.push(row);
        }
      }
    }

    // Phase 3: insert all valid non-duplicate rows in a single transaction
    let imported = 0;
    if (toInsert.length > 0) {
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of toInsert) {
          await client.query(
            `INSERT INTO contacts (id, user_id, name, wallet_address, notes, memo_required, default_memo, tags)
             VALUES ($1, $2, $3, $4, $5, false, NULL, '{}')`,
            [uuidv4(), req.user.userId, row.name, row.address, row.email || null]
          );
          imported++;
        }
        await client.query('COMMIT');
      } catch (insertErr) {
        await client.query('ROLLBACK');
        client.release();
        return next(insertErr);
      }
      client.release();
    }

    return res.status(200).json({
      imported,
      skipped_duplicates: skippedDuplicates,
      failed: errors.length,
      errors,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getContacts, addContact, deleteContact, importContacts, getImportTemplate };
