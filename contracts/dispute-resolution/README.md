# Dispute Resolution Contract

The dispute resolution contract provides a decentralized mechanism for resolving disputes between parties. It supports filing disputes, casting votes, appealing decisions, and claiming funds after expiry.

## Overview

- **Open a dispute**: A party (`opener`) locks `amount + filing_fee` into the contract. The opener may be either the `sender` or the `recipient` of the underlying payment.
- **Voting**: Designated voters cast votes to resolve the dispute.
- **Appeals**: Either party may appeal a resolution by paying an appeal fee.
- **Expiry**: If a dispute is not resolved within the expiry window, the locked funds can be reclaimed.

## Funds Ownership

Because `open_dispute` pulls `amount + filing_fee` from the `opener`, the contract records the depositor explicitly in the `Dispute` struct as `funds_owner`.

- `funds_owner` is set to the `opener` at dispute creation time.
- On expiry, `claim_expired` refunds `dispute.amount` to `dispute.funds_owner` and is callable by the funds owner.
- This ensures that a recipient who opens a dispute in good faith cannot lose their locked funds to the sender simply because the dispute expired unresolved.

### Decision on free-form disputes

Free-form disputes (not linked to an escrow or payment ID) remain allowed. The `sender`, `recipient`, and `amount` arguments are supplied by the opener and are not verified against an on-chain payment. This is intentional: the contract is a general-purpose dispute resolution primitive, and callers who need payment binding should use `open_escrow_dispute`, which verifies the dispute against the escrow contract.

## API

### `open_dispute(opener, sender, recipient, amount)`

Opens a new dispute. Transfers `amount + filing_fee` from `opener` into the contract and records `funds_owner = opener`.

### `claim_expired(dispute_id)`

Refunds `dispute.amount` to `dispute.funds_owner` when the dispute has expired without resolution. Callable by the funds owner.

### `finalize_resolution(dispute_id)` / `resolve_appeal(dispute_id)` / `cast_vote(dispute_id, vote)`

Resolve the dispute according to the panel's decision. Payouts follow the recorded `funds_owner` attribution so that funds cannot leak to a party that did not supply them.
