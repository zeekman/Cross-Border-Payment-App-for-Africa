# Soroban Contract Upgrade Process

## Overview

Every AfriPay Soroban contract (all 9) uses the shared `afripay-governance`
crate (`contracts/afripay-governance`), which adds **on-chain timelocked** WASM
upgrades and versioned migrations (SC-172 / SC-173). The fund-holding contracts
also get an emergency pause (SC-174).

The crate exports `GovKey`, `PendingUpgrade`, `UPGRADE_TIMELOCK_SECS`, the free
functions (`propose_upgrade`, `cancel_upgrade`, `execute_upgrade`, `migrate`,
`pause`, `unpause`, `paused`, `require_not_paused`) generic over the
`AdminStore` trait, and the `governance_impl!(ContractType, version)` macro.
Each contract implements `AdminStore` for its own storage layout (instance or
persistent) and expands the exported entry points with a single line:

```rust
afripay_governance::governance_impl!(Contract, CONTRACT_VERSION);
```

Fixes to governance (TTL bumps, admin rotation, event changes) are made once in
the shared crate instead of in nine copies.

## Upgrade Mechanism

### Entry points (every contract)

| Function | Auth | Description |
|---|---|---|
| `propose_upgrade(admin, new_wasm_hash) -> u64` | admin | Stores `(hash, eta)` with `eta = now + 48h`; emits `UpgradeProposed(hash, eta)`. Returns `eta`. Panics with `Upgrade already pending; cancel it first` if a proposal is already pending, and rejects a hash equal to the pending hash. |
| `upgrade(admin, new_wasm_hash) -> u64` | admin | Alias of `propose_upgrade`. Upgrades are **never** applied instantly. |
| `cancel_upgrade(admin)` | admin | Removes the pending upgrade; emits `UpgradeCancelled(hash)`. |
| `execute_upgrade(admin)` | admin | Panics with `Upgrade timelock has not expired` before `eta`; afterwards swaps the WASM and emits `Upgraded(hash)` — the event carries **only the new WASM hash**, never a version (the running code is still the old binary, so any version it reported would be wrong). |
| `cancel_upgrade(admin)` | admin | Removes the pending upgrade; emits `UpgradeCancelled(hash)`. Required before a new proposal can replace an existing one. |
| `execute_upgrade(admin)` | admin | Panics with `Upgrade timelock has not expired` before `eta`; afterwards swaps the WASM and emits `Upgraded(hash, CONTRACT_VERSION)`. |
| `get_pending_upgrade() -> Option<PendingUpgrade>` | — | The pending `{ new_wasm_hash, eta }`, if any. |
| `migrate(admin)` | admin | Idempotent; runs every intermediate migration step exactly once and bumps the stored version to the new WASM's `CONTRACT_VERSION`; emits `Migrated { from_version, to_version }`. |
| `get_contract_version() -> u32` | — | Stored contract version (`0` before the first `migrate`). |

### `execute_upgrade` must be followed by `migrate`

`execute_upgrade` only schedules the WASM swap: `update_current_contract_wasm`
takes effect **after** the invocation ends, so the call runs in the *old*
binary. The new code's `migrate` is what actually brings storage up to date.
**Always call `migrate` immediately after `execute_upgrade`, in the same
deployment run** — an upgraded contract that has not been migrated is running
new code against old storage. `scripts/upgrade.sh execute <contract>` performs
both calls for you.

`migrate` is structured as a loop over versions:

```rust
while current < CONTRACT_VERSION {
    match current {
        1 => migrate_v1_to_v2(&env),
        // ... one arm per version bump
        _ => {}
    }
    current += 1;
}
```

so a v1 → v3 jump runs the v2 step and then the v3 step, each exactly once,
and re-running `migrate` is a no-op. The emitted `Migrated { from_version,
to_version }` event records which migrations ran on-chain.

The timelock (`UPGRADE_TIMELOCK_SECS = 48h`) is enforced by the contract
itself, so a compromised admin key cannot replace contract code without giving
users a 48-hour on-chain window to exit. For extra safety, set the admin to the
`multisig-approval` contract.

### Replacement rule (SC-185)

A pending upgrade can only be replaced by an explicit `cancel_upgrade` followed
by a fresh `propose_upgrade`. `propose_upgrade` panics with
`Upgrade already pending; cancel it first` while a proposal is pending, so
watchers never see a silently swapped hash: every withdrawal is announced by an
`UpgradeCancelled` event before the new `UpgradeProposed`. A proposal whose hash
equals the pending hash is rejected, so a no-op proposal cannot restart the
48-hour clock.

## Upgrade Process

Use [`scripts/upgrade.sh`](scripts/upgrade.sh), which works for every contract
name. It needs `SOROBAN_ADMIN_KEYPAIR`, `ADMIN_ADDRESS` and the contract ID in
`<NAME>_CONTRACT_ID` (env or `contracts/.env`, as written by `deploy.sh`).

```bash
./scripts/upgrade.sh build    <contract>   # cargo build the WASM
./scripts/upgrade.sh propose  <contract>   # upload WASM + propose_upgrade (starts 48h timelock)
./scripts/upgrade.sh status   <contract>   # get_pending_upgrade + get_contract_version
./scripts/upgrade.sh execute  <contract>   # execute_upgrade + migrate (after eta)
./scripts/upgrade.sh cancel   <contract>   # cancel_upgrade
```

1. **Build & test** the new version on testnet; bump `CONTRACT_VERSION` in
   `src/governance.rs` and add a `migrate_vN_to_vN+1` step (plus its arm in
   `migrate`) for every version you skip over.
1. **Build & test** the new version on testnet; bump the version passed to
   `governance_impl!` in the contract's `lib.rs` and add any migration logic to
   `migrate`.
2. **Propose**: `upgrade.sh propose <contract>`. Announce the hash and `eta`
   publicly (indexed `UpgradeProposed` event). If a proposal is already
   pending, run `upgrade.sh cancel <contract>` first — `propose_upgrade` will
   panic otherwise.
3. **Wait 48 hours** for community review. Cancel with `upgrade.sh cancel` if a
   problem is found.
4. **Execute**: `upgrade.sh execute <contract>` (calls `execute_upgrade`, then
   `migrate` in the same run — never run one without the other).
5. **Verify**: `upgrade.sh status <contract>` shows no pending upgrade and the
   new version, and the `Migrated { from_version, to_version }` event shows the
   expected version jump.

## Emergency Pause (SC-174)

`escrow`, `agent-escrow`, `savings-vault`, `dispute-resolution` and
`loyalty-token` expose `pause(admin)`, `unpause(admin)` and `is_paused()`
(events `Paused` / `Unpaused`). `fee-distributor` and `recurring-payments`
keep their existing pause.

**Exit-path policy:** while paused, entry points that move funds *into* the
contract (or mint/transfer value) panic with `Contract is paused`. Exit paths
stay available so users can always recover funds:

| Contract | Blocked while paused | Still available |
|---|---|---|
| escrow | `create_escrow`, `batch_create_escrow`, `deposit` | release, partial release, cancel, expire, dispute (already-open escrows) |
| agent-escrow | `create_escrow` | confirm/partial payout, cancel, admin release |
| savings-vault | `deposit` | `withdraw`, emergency withdraw/return, `claim_yield` |
| dispute-resolution | `open_dispute`, `open_escrow_dispute` | evidence, voting, resolution, appeals, `claim_expired` |
| loyalty-token | `mint`, `transfer`, `transfer_from` | `burn`, `burn_from`, `redeem`, approvals |

## Per-contract Migration Notes

| Contract | `CONTRACT_VERSION` | Notes |
|---|---|---|
| escrow | 4 | Previously had an *instant* `upgrade`; now timelocked. `ContractVersion` storage key is unchanged (v3 deployments read correctly). Run `migrate` after upgrading to v4. |
| agent-escrow | 1 | First upgradeable version. Existing deployments must be redeployed once (no upgrade entry point before this release); funds migrated manually. |
| dispute-resolution | 1 | As above. Pause blocks escrow disputes too (escrow's `dispute_escrow` reverts atomically). |
| fee-distributor | 1 | As above. Uses its existing `pause`. |
| kyc-attestation | 1 | As above. Attestations must be re-issued on the new deployment. |
| loyalty-token | 1 | As above. Balances must be snapshotted and re-minted on the new deployment. |
| multisig-approval | 1 | As above. Admin is read from instance storage; governance keys live in persistent storage. |
| recurring-payments | 1 | As above. Uses its existing `pause`. |
| savings-vault | 1 | As above. |

Governance storage keys (`ContractVersion`, `PendingUpgrade`, `Paused`) are the
shared `GovKey` enum from `afripay-governance`; they encode identically to
same-named `DataKey` variants, so never add a `DataKey` variant with one of
those names for a different purpose. The encoding is byte-identical to the
pre-extraction copies, so already-deployed contracts keep reading their stored
`ContractVersion`.

## Safety Considerations

1. **Always test first** on testnet before mainnet.
2. **Back up state** (export contract storage) before upgrading.
3. **Monitor** `UpgradeProposed` events — an unexpected proposal is a signal
   to pause and investigate; users have 48 h to exit.
4. Upgrades are **irreversible**; a rollback is a new proposal of the old
   WASM hash, subject to the same timelock.

## Further Reading

- [Soroban Contract Documentation](https://developers.stellar.org/docs/smart-contracts)
- [Contract Instance Upgrade](https://developers.stellar.org/docs/smart-contracts/upgrading)
- [Event Indexing](./../backend/docs/CONTRACT_EVENTS.md)
