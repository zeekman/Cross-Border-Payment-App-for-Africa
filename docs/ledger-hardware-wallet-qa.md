# Ledger Hardware Wallet — Manual QA Checklist

**Relates to:** FE-027  
**Component:** `frontend/src/components/LedgerSignModal.jsx`, `frontend/src/components/XDRInspectorModal.jsx`

---

## Why a manual checklist?

The `@ledgerhq/hw-transport-webusb` package is mocked in the test suite
(`frontend/src/__mocks__/@ledgerhq/`), so automated tests never communicate with a
real USB device.  This checklist covers the scenarios that can only be verified with
a physical Ledger device.

---

## Prerequisites

- A Ledger Nano S / Nano S Plus / Nano X (firmware up to date)
- Stellar app ≥ 5.0.0 installed via Ledger Live
- The AfriPay frontend running against **testnet**
- A funded testnet account with the Stellar public key imported into the Stellar app
- Chrome or Edge (WebUSB support required; Firefox is not supported)

---

## Test Cases

### TC-01 — XDR Inspector shown before sign prompt (Payment)

**Steps**

1. Navigate to Send Money, enter a valid testnet recipient address and amount.
2. On the confirmation step, choose "Sign with Ledger".
3. The `LedgerSignModal` opens.

**Expected**

- The "Sign Transaction" button is **disabled** and shows tooltip "You must review the transaction before signing".
- A "Review Transaction" button is prominently shown (Step 1).
- Clicking "Review Transaction" opens `XDRInspectorModal` with the decoded operations.
- The Decoded tab shows: Source Account, Fee, Sequence, and at least one Operation of type `payment` with the correct destination and amount.
- After closing the inspector, the "Transaction reviewed ✓" indicator is shown.
- The "Sign Transaction" button becomes **enabled**.

**Pass / Fail:**

---

### TC-02 — XDR Inspector shown before sign prompt (Escrow Creation)

**Steps**

1. Navigate to Escrow, fill in the form, and select "Sign with Ledger".

**Expected** — same gating behaviour as TC-01; the decoded operation should be `invokeHostFunction (Soroban)`.

**Pass / Fail:**

---

### TC-03 — XDR Inspector shown before sign prompt (Multisig Approval)

**Steps**

1. Navigate to a multisig-pending transaction and choose "Approve with Ledger".

**Expected** — same gating behaviour as TC-01; decoded operation type visible.

**Pass / Fail:**

---

### TC-04 — Mismatch warning displayed (tampered amount)

**Steps**

1. Using browser DevTools, intercept the `/api/payments/build-tx` response and alter the XDR amount field to a different value.
2. Open `LedgerSignModal` with both `expectedAmount` and the tampered XDR.

**Expected**

- A red mismatch warning banner is displayed **before** the user can reach the sign button.
- The banner shows the original expected amount and the decoded (tampered) amount side by side.

**Pass / Fail:**

---

### TC-05 — Mismatch warning displayed (tampered recipient)

**Steps** — same as TC-04 but alter the destination address in the XDR.

**Expected** — warning banner shows expected vs decoded recipient address.

**Pass / Fail:**

---

### TC-06 — Successful signing (Payment)

**Steps**

1. Complete TC-01 review step.
2. Plug in Ledger, unlock it, open Stellar app.
3. Click "Sign Transaction".

**Expected**

- Ledger device screen shows the transaction details (amount + destination).
- Approving on the device completes the signing; the modal closes with a success toast.
- The transaction is broadcast to Horizon (check Stellar Expert testnet).

**Pass / Fail:**

---

### TC-07 — User rejects on Ledger device

**Steps**

1. Complete TC-01 review step.
2. Plug in Ledger, open Stellar app.
3. Click "Sign Transaction", then **reject** on the Ledger screen.

**Expected**

- An error toast is shown: "Transaction was rejected on your Ledger device."
- The modal remains open so the user can retry or cancel.

**Pass / Fail:**

---

### TC-08 — Ledger device locked

**Steps**

1. Lock the Ledger before clicking "Sign Transaction".

**Expected**

- Error toast: "Your Ledger device is locked. Please unlock it and try again."

**Pass / Fail:**

---

### TC-09 — Stellar app not open

**Steps**

1. Leave Ledger on the home screen (Stellar app closed).
2. Click "Sign Transaction".

**Expected**

- Error toast: "Stellar app is not open on your Ledger device. Open it and try again."

**Pass / Fail:**

---

### TC-10 — Cancel before reviewing

**Steps**

1. Open `LedgerSignModal`.
2. Click "Cancel" without opening the XDR Inspector.

**Expected**

- Modal closes. No signing prompt is shown. No error is thrown.

**Pass / Fail:**

---

## Sign-off

| Date | Tester | Device | Firmware | Stellar app | Result |
|------|--------|--------|----------|-------------|--------|
|      |        |        |          |             |        |

---

## Notes

- The WebUSB mock (`@ledgerhq/hw-transport-webusb`) resolves a fake `{ signature: { publicKey: '...', signature: Buffer } }` immediately, which means automated tests validate the **UI gating logic** but not the device communication path.
- If the Stellar app version on the device is older than 5.0.0, hash signing may be required for Soroban transactions.  Ensure the Stellar app settings have "Allow blind signing" set to **disabled** to verify that the decoder path is exercised.
