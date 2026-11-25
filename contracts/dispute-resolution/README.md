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

## Escrow disputes and the payout agent

`open_escrow_dispute(escrow_contract, escrow_id, sender, recipient, agent, amount, payout_confirmed)`
is called only by the registered escrow contract. Escrow funds are released to
the **agent**, who pays the recipient in fiat off-chain, so the agent is a party
to the dispute (#1366):

- The agent may `submit_evidence` (read back with `get_agent_evidence`) and `appeal`.
- The arbitrator may award the funds to the agent with `resolve_dispute_for_agent`;
  the super-arbitrator with `resolve_appeal_for_agent`. The dispute then ends in
  `ResolvedForAgent`. The multi-arbitrator panel (`cast_vote`) still votes only
  for sender or recipient.
- `payout_confirmed` (see `is_payout_confirmed`) records whether the agent had
  confirmed delivery. If so and the dispute expires unresolved, only the agent
  may `claim_expired`, and the funds go to the agent (`DisputeExpiredToAgent`
  event). Otherwise the sender is refunded as usual.
- `get_dispute_agent` returns the agent (`None` for free-form disputes).
- `escrow_id` is stored with the dispute. Every settlement path
  (`finalize_resolution`, `resolve_appeal*`, `cast_vote` quorum,
  `claim_expired`) pays the winner and then calls the escrow's
  `close_disputed_escrow(escrow_id, winner)` so the escrow leaves
  `UnderDispute` (#1367).

## API

### `open_dispute(opener, sender, recipient, amount)`

Opens a new dispute. Transfers `amount + filing_fee` from `opener` into the contract and records `funds_owner = opener`.

### `claim_expired(dispute_id)`

Refunds `dispute.amount` to `dispute.funds_owner` when the dispute has expired without resolution. Callable by the funds owner.

### `finalize_resolution(dispute_id)` / `resolve_appeal(dispute_id)` / `cast_vote(dispute_id, vote)`

Resolve the dispute according to the panel's decision. Payouts follow the recorded `funds_owner` attribution so that funds cannot leak to a party that did not supply them.
