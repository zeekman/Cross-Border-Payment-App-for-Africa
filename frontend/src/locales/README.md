# AfriPay Localization

## Supported Languages

| Code | Language | Native Name | Status |
|------|----------|-------------|--------|
| en   | English | English | ✅ Complete |
| sw   | Swahili | Kiswahili | ✅ Complete |
| fr   | French | Français | ✅ Complete |
| ha   | Hausa | Hausa | ✅ Complete |
| yo   | Yoruba | Yorùbá | ✅ Complete |
| pt   | Portuguese | Português | ⚠️ Stub only (needs translation) |
| am   | Amharic | አማርኛ | ⚠️ Stub only (needs translation) |

## Adding a New Language

1. **Create the locale directory and translation file:**
   ```bash
   cd frontend
   npm run i18n:stub pt "Português"
   ```

2. **Translate all keys** in `<locale>/translation.json`
   - Replace all English text with translated text
   - Preserve all interpolation variables like `{{count}}`, `{{seconds}}`, etc.
   - Keep the same JSON structure
   - DO NOT translate keys (left side of `:`) — only values (right side)

3. **Import the locale** in `src/i18n.js`

4. **Check translation parity:**
   ```bash
   npm run i18n:check
   ```

## Portuguese & Amharic Locales

**Status:** Infrastructure complete, requires professional translation.

Both `pt/translation.json` and `am/translation.json` currently contain English text as placeholders.
They need professional translation before production use.

### Next Steps:
- Hire professional Portuguese translator
- Hire professional Amharic translator  
- Add Noto Sans Ethiopic font for Amharic (Ge'ez script)
- Update language selectors in Profile/Welcome pages
- Test responsive layouts at 360px for Portuguese text expansion
- Test Amharic rendering on Android Chrome

## CI Integration

The CI pipeline runs `npm run i18n:check` to ensure all locales have translation parity.
