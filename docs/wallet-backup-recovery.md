# Wallet Backup & Recovery

AfriPay generates a Stellar keypair for every user at registration. The secret key is encrypted with AES-256-CBC and stored in the database — your wallet is only accessible through AfriPay's infrastructure unless you export and store the key yourself.

---

## Understanding the Risk

| Scenario | Outcome without backup | Outcome with backup |
|---|---|---|
| Forgot AfriPay password | Use "Forgot Password" flow | Use "Forgot Password" flow |
| AfriPay service unavailable | Cannot access funds | Import key into any Stellar wallet |
| Account permanently deleted | Funds inaccessible | Import key into any Stellar wallet |

**Recommendation:** Export your secret key and store it offline as soon as you create your account.

---

## Exporting Your Secret Key (Backup)

1. Open the app → **Profile** tab
2. Scroll to **Backup Wallet** → tap **Export Key**
3. Read the warning and enter your **account password** (not your PIN)
4. Tap **Reveal Secret Key**
5. Copy the key and store it securely (see storage tips below)
6. Tap **Done** — the key will not be shown again in this session

### API

```
POST /api/wallet/export-key
Authorization: Bearer <jwt>
Content-Type: application/json

{ "password": "your_account_password" }
```

Response:
```json
{ "secret_key": "S..." }
```

Requires a valid JWT **and** correct account password. The JWT alone is not sufficient.

---

## Importing an Existing Wallet (Recovery / Migration)

If you already have a Stellar wallet (e.g. from Lobstr, Solar, or a previous AfriPay account), you can link it during registration instead of generating a new one.

1. On the **Register** screen, expand **Already have a Stellar wallet? Import it**
2. Paste your secret key (starts with `S`)
3. Complete registration normally

AfriPay will validate the key, derive the public key, encrypt the secret key, and store it — the same way a newly generated wallet is stored.

> You cannot import a wallet into an existing account after registration. Create a new account if you need to link a different keypair.

---

## Secure Storage Tips

- **Write it down** on paper and store in a physically secure location (safe, lockbox)
- **Do not** store it in email, SMS, cloud notes, or screenshots
- **Do not** share it with anyone — AfriPay support will never ask for it
- Consider splitting the key across two secure locations for extra protection

---

## Using Your Key Outside AfriPay

Your exported secret key is a standard Stellar Ed25519 secret seed. It works with any Stellar-compatible wallet:

- [Lobstr](https://lobstr.co) — import via Settings → Import Account
- [Solar Wallet](https://solarwallet.io) — import via Add Account → Secret Key
- [Stellar Laboratory](https://laboratory.stellar.org) — for advanced operations

---

## Security Properties

- Secret keys are encrypted with **AES-256-CBC** before database storage — never stored in plaintext
- Key export requires **password re-verification** in addition to a valid JWT session
- The export endpoint is rate-limited alongside all other auth-sensitive endpoints
- AfriPay never logs or caches the decrypted secret key
