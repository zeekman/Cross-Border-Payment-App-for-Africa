#!/usr/bin/env node
/**
 * Generate translation stub files for new locales
 * Creates a copy of en/translation.json with placeholder translations
 * 
 * Usage: node scripts/generate-translation-stub.js <locale-code> <locale-name>
 * Example: node scripts/generate-translation-stub.js pt "Português"
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node generate-translation-stub.js <locale-code> <locale-name>');
  console.error('Example: node generate-translation-stub.js pt "Português"');
  process.exit(1);
}

const [localeCode, localeName] = args;
const LOCALES_DIR = path.join(__dirname, '../src/locales');
const EN_PATH = path.join(LOCALES_DIR, 'en/translation.json');
const NEW_LOCALE_DIR = path.join(LOCALES_DIR, localeCode);
const NEW_LOCALE_PATH = path.join(NEW_LOCALE_DIR, 'translation.json');

if (!fs.existsSync(EN_PATH)) {
  console.error(`Error: Base locale file not found: ${EN_PATH}`);
  process.exit(1);
}

if (fs.existsSync(NEW_LOCALE_PATH)) {
  console.error(`Error: ${localeCode}/translation.json already exists`);
  process.exit(1);
}

// Create the directory
if (!fs.existsSync(NEW_LOCALE_DIR)) {
  fs.mkdirSync(NEW_LOCALE_DIR, { recursive: true });
}

// Read the English translation
const enTranslation = JSON.parse(fs.readFileSync(EN_PATH, 'utf8'));

// Add a header comment
const header = `{
  "_meta": {
    "locale": "${localeCode}",
    "name": "${localeName}",
    "note": "Machine-translated placeholders. MUST be reviewed by native speakers before production use."
  },`;

// Write the stub file (copy of English for now)
const content = JSON.stringify(enTranslation, null, 2);
// Insert the meta header after the opening brace
const contentWithMeta = content.replace(/^{/, header);

fs.writeFileSync(NEW_LOCALE_PATH, contentWithMeta, 'utf8');

console.log(`✅ Created ${localeCode}/translation.json`);
console.log(`⚠️  This file contains English placeholder text.`);
console.log(`    Replace with ${localeName} translations before production use.`);
