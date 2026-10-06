# Changelog

All notable changes to AfriPay are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Breaking changes are marked **[BREAKING]**.

---

## [Unreleased]

### Security — backend routes (`backend/src/routes/wallet.js`)

#### Fixed: `GET /api/wallet/signers` bypassed admin/owner authorization (BE-001, issue #948)

`GET /api/wallet/signers` was registered twice — once with no authorization
middleware, then again correctly guarded by `isAdminOrOwner()`. Express
dispatches to the first matching registration for a given method+path, so the
unprotected copy always won and the protected copy was dead code. Any
authenticated user (not just an account admin/owner) could call the endpoint.

- **Introduced:** 2026-03-28 (`3ef2d463`, initial multisig support), when the
  route existed only in its unprotected form.
- **Regressed to dead-code duplicate:** 2026-05-31 (`3e08fc16`), when
  `isAdminOrOwner()` protection was added as a second registration instead of
  replacing the first.
- **Fixed:** 2026-08-29 — removed the unprotected registration; only the
  `isAdminOrOwner()`-guarded route is now reachable.
- **Exposure window:** 2026-03-28 through 2026-08-29.
- A duplicate-route CI check (`backend/scripts/check-duplicate-routes.js`)
  now fails the build on any (method, path) registered more than once in a
  router file, so this class of bug can't silently regress again.

### Changed — agent-escrow contract (`contracts/agent-escrow`)

#### **[BREAKING]** Standardized Soroban event topic scheme

All contract events now use a **two-element topic vector**:

```
topic[0] = Symbol("AgentEscrow")   ← contract name, used as Horizon filter prefix
topic[1] = Symbol("<EventName>")   ← specific event name (see table below)
```

Previously every event used a single-element topic vector, e.g. `(Symbol("EscrowCreated"),)`.
Any off-chain subscriber filtering on the old single-element topics will stop receiving events
after this contract is redeployed and must be updated to match the new two-element scheme.

| Event | Old topic (single) | New topic[0] | New topic[1] |
|---|---|---|---|
| Escrow created | `EscrowCreated` | `AgentEscrow` | `EscrowCreated` |
| Payout confirmed | `PayoutConfirmed` | `AgentEscrow` | `EscrowConfirmed` |
| Escrow cancelled | `EscrowCancelled` | `AgentEscrow` | `EscrowCancelled` |
| Admin override | `AdminOverride` | `AgentEscrow` | `AdminOverride` |

#### **[BREAKING]** Updated event data payloads

| Struct | Field changes |
|---|---|
| `EvtEscrowCreated` (was `EvtCreated`) | `fee_bps` field **removed**; all other fields unchanged |
| `EvtEscrowConfirmed` (was `EvtCompleted`) | `agent: Address` field **added** |
| `EvtEscrowCancelled` (was `EvtCancelled`) | `sender: Address` field **added** |

#### **[BREAKING]** `PayoutConfirmed` event renamed to `EscrowConfirmed`

Subscribers listening for `PayoutConfirmed` must update to `EscrowConfirmed`.

---

### Fixed — backend service (`backend/src/services/agentEscrow.js`)

- `confirmPayout` was calling the non-existent contract method `confirm_delivery`.
  It now correctly calls `confirm_payout`, matching the deployed contract ABI.

### Added — backend service (`backend/src/services/agentEscrow.js`)

- `ESCROW_EVENT_NAMES` — frozen constant object mapping logical names to the
  on-chain event name strings:
  ```js
  ESCROW_EVENT_NAMES.CREATED        // "EscrowCreated"
  ESCROW_EVENT_NAMES.CONFIRMED      // "EscrowConfirmed"
  ESCROW_EVENT_NAMES.CANCELLED      // "EscrowCancelled"
  ESCROW_EVENT_NAMES.ADMIN_OVERRIDE // "AdminOverride"
  ```
- `subscribeToEscrowEvents(eventName, onEvent, onError)` — opens a Horizon
  contract-event SSE stream filtered to `[AgentEscrow, eventName]` and invokes
  `onEvent(event)` for each matching event. Returns a `close()` function.

  ```js
  const { subscribeToEscrowEvents, ESCROW_EVENT_NAMES } = require('./services/agentEscrow');

  const stop = subscribeToEscrowEvents(
    ESCROW_EVENT_NAMES.CONFIRMED,
    (evt) => console.log('payout confirmed', evt),
    (err) => console.error('stream error', err),
  );
  // later…
  stop();
  ```

---

## Migration Guide

### Contract redeployment

The event schema changes require a **new contract deployment**. You cannot
upgrade event topics on an already-deployed contract without redeployment.

1. Build and deploy the updated contract:
   ```bash
   cd contracts/agent-escrow
   cargo build --target wasm32-unknown-unknown --release
   stellar contract deploy --wasm target/wasm32-unknown-unknown/release/agent_escrow_contract.wasm \
     --network testnet --source <admin-keypair>
   ```
2. Update `AGENT_ESCROW_CONTRACT_ID` in your `.env` to the new contract address.
3. Re-initialize the new contract:
   ```bash
   stellar contract invoke --id <new-contract-id> -- initialize \
     --admin <admin-address> \
     --usdc_address <usdc-sac-address> \
     --cancel_window_seconds 172800
   ```

### Updating Horizon event subscribers

Replace any existing single-element topic filter with the two-element scheme.

**Before (old single-element filter):**
```js
// Was listening for { topic: ["EscrowCreated"] }
server.contractEvents()
  .forContract(CONTRACT_ID)
  .stream({ onmessage: handler });
```

**After (new two-element filter via the helper):**
```js
const { subscribeToEscrowEvents, ESCROW_EVENT_NAMES } = require('./services/agentEscrow');

const stop = subscribeToEscrowEvents(ESCROW_EVENT_NAMES.CREATED, handler);
```

Or, if filtering manually via Horizon's `topic` query parameter:
```
GET /contract_events?contract_id=<id>&topic=AgentEscrow,EscrowCreated
```

### Updating event payload consumers

| If your code reads… | Change to… |
|---|---|
| `event.data.fee_bps` on `EscrowCreated` | Read `fee_bps` from `get_escrow()` instead |
| `PayoutConfirmed` event data | Use `EscrowConfirmed`; decode `agent`, `agent_amount`, `fee_amount` |
| `EscrowCancelled` event data | Decode added `sender` field |
