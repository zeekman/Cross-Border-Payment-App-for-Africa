# Savings Vault Contract

## Emergency Mode State Machine

The savings vault features an admin-controlled emergency mode surface governed by six functions:
1. `announce_emergency`
2. `cancel_emergency`
3. `emergency_withdraw`
4. `activate_emergency`
5. `deactivate_emergency`
6. `emergency_return_funds`

### State Transition Diagram

```
                 +-------------------+
                 |      Normal       |
                 +-------------------+
                   /               \
 announce_emergency/                 \activate_emergency
                  v                   v
     +--------------------+   +--------------------+
     | EmergencyAnnounced |   |  EmergencyActive   |
     +--------------------+   +--------------------+
        |              |         |              |
 cancel_|   emergency_ | deactiv_|   emergency_ |
 emerg. |    withdraw  | ate_em. |  return_funds|
 (t<48h)|     (t>=48h) | (t<48h) |     (t>=48h) |
        v              v         v              v
     +------+       +------+  +------+       +------+
     |Normal|       |Closed|  |Normal|       |Closed|
     +------+       |Vault |  +------+       |Vault |
                    +------+                 +------+
```

### States & Invariants

1. **Normal (Idle)**:
   - `EmergencyWithdrawalAnnounced == 0`
   - `EmergencyActivated == false`
   - Normal deposits and withdrawals operate under standard lock and penalty rules.

2. **EmergencyAnnounced**:
   - `EmergencyWithdrawalAnnounced > 0`
   - Initiated via `announce_emergency(admin)`.
   - Cannot be announced again while already announced (double-announce rejected).
   - Can be cancelled within 48 hours via `cancel_emergency(admin)` -> returns to `Normal`.
   - Cannot be cancelled after 48 hours.
   - After 48 hours, `emergency_withdraw(admin, user)` can be executed -> transfers full vault balance to user, cleans up the vault, and updates `TotalLocked`.

3. **EmergencyActive**:
   - `EmergencyActivated == true`, `EmergencyActivatedAt > 0`
   - Initiated via `activate_emergency(admin)`.
   - Cannot be activated again while already active (double-activate rejected).
   - Can be deactivated via `deactivate_emergency(admin)` -> returns to `Normal`.
   - After 48 hours, `emergency_return_funds(admin, user)` can be executed -> transfers full vault balance to user, cleans up the vault, and updates `TotalLocked`.

### Mutual Exclusivity & Safety

- `emergency_withdraw` and `emergency_return_funds` are mutually exclusive per vault. When either function executes, the user's vault record is deleted from storage (`env.storage().persistent().remove(&vault_key)`). Any subsequent call to `emergency_withdraw`, `emergency_return_funds`, or `withdraw` for that vault will panic with `No vault found for user` or `No balance to return`.
- Calling `deactivate_emergency` without `activate_emergency` panics with `"no emergency active"`.
- Calling `cancel_emergency` without `announce_emergency` panics with `"no emergency announced"`.
- Calling `emergency_withdraw` before 48 hours elapsed panics with `"emergency withdrawal not yet allowed"`.
- Calling `emergency_return_funds` before 48 hours elapsed panics with `"emergency return not yet allowed: 48h not elapsed"`.
## Overview
The Savings Vault contract allows users to deposit tokens for fixed periods, earn interest over time, and participate in platform yield distributions.

## Operational Runbooks

### SC-036: Fee / Distributor Key Loss & Rotation Runbook

The savings vault relies on authorized distributor addresses:
- **Fee Distributor (`fund_interest_reserve`)**: Address authorized to top up the platform interest reserve pool.
- **Yield Distributor (`distribute_yield`)**: Address authorized to push platform fee yield allocations to vault holders.

#### Incident Scenario
A distributor key (private key or hot wallet) is compromised, lost, or needs scheduled rotation.

#### Immediate Response & Key Rotation
1. **Identify the compromised key** and halt any off-chain automated scripts using it to distribute yield or fund reserves.
2. **Admin Key Authorization**: As long as the admin key is intact, call `set_fee_distributor` and/or `set_yield_distributor` from the admin address to reassign the authorized distributor to a secure new address:
   - `client.set_fee_distributor(&admin, &new_distributor_address)`
   - `client.set_yield_distributor(&admin, &new_distributor_address)`
3. **Execution Latency**: Reassignment takes effect immediately upon transaction inclusion on the Stellar ledger (typically ~5 seconds ledger close time). No timelock or multi-day delay is imposed on distributor rotation, ensuring rapid containment during an incident.

#### Status of Existing User Funds & Accrued Yield
- **No Interruption to User Yield**: Already-accrued interest (`vault.accrued_interest`) and claimed/unclaimed user balances are stored on-ledger in persistent contract storage. Rotating the distributor address does **not** reset or pause user withdrawals, interest claims (`claim_yield`), or standard principal withdrawals (`withdraw`).
- **Safety of Reserves**: The distributor key can only deposit funds into the contract via `fund_interest_reserve` or `distribute_yield`. It has no privilege to drain user principal or siphon off reserve funds.

### SC-035: Yield Accrual Model & Flash-Deposit Analysis
- **Yield & Interest Accrual Model**: Interest accrual (`accrue_interest`) is strictly **time-weighted** continuously based on elapsed seconds:
  $$\text{interest} = \frac{\text{balance} \times \text{rate\_bps} \times \Delta t}{10000 \times \text{SECONDS\_PER\_YEAR}}$$
- Depositing immediately prior to an accrual period and withdrawing immediately after captures only interest proportional to the elapsed seconds ($\Delta t$), making "flash deposit" gaming unviable.

### SC-033: Emergency Mode & Recovery
- The admin can announce emergency mode (`announce_emergency_return`) requiring an on-chain delay period before activation, protecting users while allowing fund returns under exceptional circumstances.
