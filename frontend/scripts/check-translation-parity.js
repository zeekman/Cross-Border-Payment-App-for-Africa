#!/usr/bin/env node
/**
 * Translation parity checker
 * Ensures all locales have the same keys as en/translation.json
 * 
 * Exit codes:
 *   0 = all locales have parity
 *   1 = missing or extra keys found
 */

const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '../src/locales');
const BASE_LOCALE = 'en';

function log(msg) {
  console.log(`[i18n-parity] ${msg}`);
}

function flattenKeys(obj, prefix = '') {
  const keys = [];
  for (const key in obj) {
    // Skip _meta keys as they're not user-facing translations
    if (key === '_meta') continue;
    
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      keys.push(...flattenKeys(obj[key], fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

function checkParity() {
  const basePath = path.join(LOCALES_DIR, BASE_LOCALE, 'translation.json');
  
  if (!fs.existsSync(basePath)) {
    console.error(`❌ Base locale file not found: ${basePath}`);
    process.exit(1);
  }
  
  const baseContent = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  const baseKeys = flattenKeys(baseContent).sort();
  
  log(`Base locale (${BASE_LOCALE}) has ${baseKeys.length} keys`);
  
  const localeDirs = fs.readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory() && dirent.name !== BASE_LOCALE)
    .map(dirent => dirent.name);
  
  if (localeDirs.length === 0) {
    log('No other locales found — parity check skipped');
    return;
  }
  
  let hasErrors = false;
  
  for (const locale of localeDirs) {
    const localePath = path.join(LOCALES_DIR, locale, 'translation.json');
    
    if (!fs.existsSync(localePath)) {
      console.error(`❌ ${locale}: translation.json not found`);
      hasErrors = true;
      continue;
    }
    
    const localeContent = JSON.parse(fs.readFileSync(localePath, 'utf8'));
    const localeKeys = flattenKeys(localeContent).sort();
    
    const missingKeys = baseKeys.filter(k => !localeKeys.includes(k));
    const extraKeys = localeKeys.filter(k => !baseKeys.includes(k));
    
    if (missingKeys.length > 0 || extraKeys.length > 0) {
      console.error(`\n❌ ${locale} has translation parity issues:`);
      
      if (missingKeys.length > 0) {
        console.error(`  Missing ${missingKeys.length} keys:`);
        missingKeys.slice(0, 10).forEach(k => console.error(`    - ${k}`));
        if (missingKeys.length > 10) {
          console.error(`    ... and ${missingKeys.length - 10} more`);
        }
      }
      
      if (extraKeys.length > 0) {
        console.error(`  Extra ${extraKeys.length} keys (not in ${BASE_LOCALE}):`);
        extraKeys.slice(0, 10).forEach(k => console.error(`    - ${k}`));
        if (extraKeys.length > 10) {
          console.error(`    ... and ${extraKeys.length - 10} more`);
        }
      }
      
      hasErrors = true;
    } else {
      log(`✅ ${locale}: ${localeKeys.length} keys (parity OK)`);
    }
  }
  
  if (hasErrors) {
    console.error('\n❌ Translation parity check failed');
    process.exit(1);
  } else {
    log('\n✅ All locales have translation parity');
  }
}

checkParity();
