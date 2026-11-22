#![no_std]

//! # KYC Attestation Contract
//!
//! On-chain KYC attestation for AfriPay. Stores a SHA-256 hash of the user's
//! KYC data — never raw PII. Any Stellar ecosystem participant can call
//! [`is_valid_and_unexpired`] to check a wallet's KYC status without trusting
//! AfriPay's centralized database.
//!
//! ## Access control
//! - `attest` and `revoke` — admin only
//! - `is_valid_and_unexpired` — public
//!
//! ## Expiry-aware vs. non-expiry-aware checks
//! - [`is_valid_and_unexpired`] is the **expiry-aware** check: it returns `true`
//!   only when an attestation exists, has not been revoked, **and** has not
//!   expired. All fund-gating decisions MUST use this variant.
//! - [`has_ever_attested`] is the **non-expiry-aware** check: it returns `true`
//!   when an attestation exists and has not been revoked, **ignoring expiry**.
//!   It is retained only for historical/audit purposes and MUST NOT be used to
//!   gate fund-moving actions.
//!
//! ## Legacy mirror keys
//! - [`DataKey::Attestation`] is a legacy, tier-agnostic mirror. It is written
//!   on every `attest`/`revoke` and therefore reflects the **last written tier**
//!   only. It MUST NOT be used for any decision; use
//!   [`DataKey::TieredAttestation`] (via [`is_valid_and_unexpired`]) instead.
//! - [`DataKey::AttestationByTier`] mirrors the record under the exact tier
//!   being attested/revoked, so it never clobbers another tier's entry.

use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, Env, Symbol};

#[cfg(test)]
mod test;

// ── Storage keys ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[contracttype]
#[repr(u32)]
pub enum KycTier {
    Basic = 0,
    Enhanced = 1,
    Business = 2,
}

#[derive(Debug)]
#[contracttype]
pub enum DataKey {
    Admin,
    PendingAdmin,
    TieredAttestation(Address, KycTier),
    Attestation(Address),
    AttestationByTier(Address, KycTier),
}

// ── Domain types ──────────────────────────────────────────────────────────────

/// On-chain KYC attestation record.
#[derive(Debug, Clone)]
#[contracttype]
pub struct Attestation {
    /// SHA-256 hash of the off-chain KYC document bundle (hex-encoded bytes).
    /// Raw PII is never stored on-chain.
    pub kyc_hash: Bytes,
    /// Unix timestamp when the attestation was issued.
    pub attested_at: u64,
    /// Unix timestamp when the attestation was revoked, or 0 if still active.
    pub revoked_at: u64,
    /// Unix ledger timestamp after which the attestation is considered expired.
    /// 0 means the attestation never expires.
    pub expires_at: u64,
    /// Number of times this attestation has been revoked. Preserves evidence
    /// of prior revocations across re-attestations.
    pub revocation_count: u32,
    /// Unix timestamp of the most recent revocation, or 0 if never revoked.
    pub last_revoked_at: u64,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
#[contracttype]
pub struct AttestationRevoked {
    pub user: Address,
    pub tier: KycTier,
}

#[derive(Debug, Clone)]
#[contracttype]
pub struct BatchRevocationCompleted {
    pub count: u32,
    pub admin: Address,
    pub timestamp: u64,
}

#[contract]
pub struct KycAttestationContract;

#[contractimpl]
impl KycAttestationContract {
    /// Initialise the contract. Must be called once.
    ///
    /// # Arguments
    /// * `admin` — The AfriPay admin address authorised to attest and revoke.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().persistent().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
    }

    /// Propose a new admin. The first step of two-step admin rotation.
    ///
    /// The current admin must authorise this call. The proposal is stored with
    /// an ETA (`now + ADMIN_ROTATION_DELAY_SECS`) and the new admin must wait
    /// until the ETA before calling [`accept_admin`]. Emits `AdminProposed`.
    ///
    /// It is strongly recommended that the admin be a multisig account or the
    /// `multisig-approval` contract so a single lost or compromised key cannot
    /// take over governance.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        let eta = env
            .ledger()
            .timestamp()
            .saturating_add(governance::ADMIN_ROTATION_DELAY_SECS);
        env.storage()
            .persistent()
            .set(&DataKey::PendingAdmin, &(new_admin.clone(), eta));

        env.events().publish(
            (Symbol::new(&env, "AdminProposed"),),
            (admin, new_admin, eta),
        );
    }

    /// Accept a pending admin proposal. The second step of two-step rotation.
    ///
    /// Requires `new_admin.require_auth()` and that the rotation delay has
    /// elapsed. Swaps `Admin` for `new_admin`, clears the pending proposal and
    /// emits `AdminChanged { old, new }`. The previous admin immediately loses
    /// all privileges.
    pub fn accept_admin(env: Env, new_admin: Address) {
        new_admin.require_auth();

        let (pending, eta): (Address, u64) = env
            .storage()
            .persistent()
            .get(&DataKey::PendingAdmin)
            .expect("no pending admin proposal");
        if pending != new_admin {
            panic!("unauthorized: caller is not the pending admin");
        }
        if env.ledger().timestamp() < eta {
            panic!("admin rotation delay has not elapsed");
        }

        let old: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("not initialized");
        env.storage().persistent().set(&DataKey::Admin, &new_admin);
        env.storage().persistent().remove(&DataKey::PendingAdmin);

        env.events()
            .publish((Symbol::new(&env, "AdminChanged"),), (old, new_admin));
    }

    /// Cancel a pending admin proposal. Only the current admin may call this.
    pub fn cancel_admin_proposal(env: Env, admin: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        env.storage().persistent().remove(&DataKey::PendingAdmin);
        env.events()
            .publish((Symbol::new(&env, "AdminProposalCancelled"),), (admin,));
    }

    /// Return the current admin address.
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }

    /// Return the pending admin proposal as `(new_admin, eta)`, if any.
    pub fn get_pending_admin(env: Env) -> Option<(Address, u64)> {
        env.storage().persistent().get(&DataKey::PendingAdmin)
    }

    /// Record a KYC attestation for `user`.
    ///
    /// Only the admin may call this. Panics if the user already has an active
    /// (non-revoked, non-expired) attestation. Re-attesting a revoked or
    /// expired attestation is allowed: it records a fresh `attested_at`,
    /// preserves the prior revocation evidence (`revocation_count`,
    /// `last_revoked_at`) and emits a distinct `KycRenewed` event.
    ///
    /// # Arguments
    /// * `admin`      — Must match the admin set during `initialize`.
    /// * `user`       — Stellar address of the verified user.
    /// * `kyc_hash`   — SHA-256 hash of the KYC document bundle. Never raw PII.
    /// * `expires_at` — Ledger timestamp after which the attestation expires.
    ///                  Pass 0 for no expiry.
    pub fn attest(
        env: Env,
        admin: Address,
        user: Address,
        tier: KycTier,
        kyc_hash: Bytes,
        expires_at: u64,
    ) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        if kyc_hash.len() == 0 {
            panic!("kyc_hash must not be empty");
        }
        let now = env.ledger().timestamp();
        if expires_at != 0 && expires_at <= now {
            panic!("expires_at must be greater than current timestamp");
        }

        let key = DataKey::TieredAttestation(user.clone(), tier.clone());

        // Re-attestation is only permitted when the existing attestation is no
        // longer active (revoked or expired). An active attestation must be
        // explicitly revoked first.
        let (revocation_count, last_revoked_at, is_renewal) =
            if let Some(existing) = env.storage().persistent().get::<_, Attestation>(&key) {
                let expired = existing.expires_at != 0 && now > existing.expires_at;
                if existing.revoked_at == 0 && !expired {
                    panic!("user already has an active attestation");
                }
                (
                    existing.revocation_count,
                    existing.last_revoked_at,
                    true,
                )
            } else {
                (0, 0, false)
            };

        let record = Attestation {
            kyc_hash,
            attested_at: now,
            revoked_at: 0,
            expires_at,
            revocation_count,
            last_revoked_at,
        };
        env.storage().persistent().set(&key, &record);
        // Legacy tier-agnostic mirror: reflects the last written tier only.
        // MUST NOT be used for decisions — see module docs.
        env.storage()
            .persistent()
            .set(&DataKey::Attestation(user.clone()), &record);
        // Mirror under the exact tier being attested so other tiers are untouched.
        env.storage().persistent().set(
            &DataKey::AttestationByTier(user.clone(), tier.clone()),
            &record,
        );

        if is_renewal {
            env.events()
                .publish((Symbol::new(&env, "KycRenewed"),), (user, tier));
        } else {
            env.events()
                .publish((Symbol::new(&env, "KycAttested"),), (user, tier));
        }
    }

    /// Revoke an existing attestation for `user` and `tier`.
    ///
    /// Only the admin may call this. Panics if no active attestation exists.
    ///
    /// # Arguments
    /// * `admin` — Must match the admin set during `initialize`.
    /// * `user`  — Stellar address whose attestation should be revoked.
    /// * `tier`  — KYC tier to revoke.
    pub fn revoke(env: Env, admin: Address, user: Address, tier: KycTier) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        let key = DataKey::TieredAttestation(user.clone(), tier.clone());
        let mut record: Attestation = env
            .storage()
            .persistent()
            .get(&key)
            .expect("no attestation found for user and tier");

        if record.revoked_at != 0 {
            panic!("attestation already revoked");
        }

        let now = env.ledger().timestamp();
        record.revoked_at = now;
        record.last_revoked_at = now;
        record.revocation_count = record.revocation_count.saturating_add(1);
        env.storage().persistent().set(&key, &record);
        // Legacy tier-agnostic mirror: reflects the last written tier only.
        // MUST NOT be used for decisions — see module docs.
        env.storage()
            .persistent()
            .set(&DataKey::Attestation(user.clone()), &record);
        // Mirror under the exact tier being revoked so other tiers are untouched.
        env.storage().persistent().set(
            &DataKey::AttestationByTier(user.clone(), tier.clone()),
            &record,
        );

        env.events().publish((Symbol::new(&env, "KycRevoked"),), (user, tier));
    }

    /// Returns `true` if `user` has a current, non-revoked, non-expired KYC attestation for `tier`.
    ///
    /// This is the **expiry-aware** check and the canonical entry point for any
    /// fund-gating decision (e.g. escrow creation). It returns `false` when the
    /// attestation is missing, has been revoked, or has passed its `expires_at`
    /// timestamp.
    ///
    /// Public — any caller may invoke this.
    ///
    /// # Arguments
    /// * `user` — Stellar address to check.
    /// * `tier` — KYC tier to verify.
    pub fn is_valid_and_unexpired(env: Env, user: Address, tier: KycTier) -> bool {
        match env
            .storage()
            .persistent()
            .get::<_, Attestation>(&DataKey::TieredAttestation(user, tier))
        {
            Some(record) => {
                if record.revoked_at != 0 {
                    return false;
                }
                if record.expires_at != 0 && env.ledger().timestamp() > record.expires_at {
                    return false;
                }
                true
            }
            None => false,
        }
    }

    /// Returns `true` if `user` has ever been attested for `tier` and that
    /// attestation has not been explicitly revoked — **ignoring expiry**.
    ///
    /// This is the **non-expiry-aware** check. It is retained only for
    /// historical/audit purposes and MUST NOT be used to gate fund-moving
    /// actions; use [`is_valid_and_unexpired`] for that instead.
    ///
    /// Public — any caller may invoke this.
    ///
    /// # Arguments
    /// * `user` — Stellar address to check.
    /// * `tier` — KYC tier to check.
    pub fn has_ever_attested(env: Env, user: Address, tier: KycTier) -> bool {
        match env
            .storage()
            .persistent()
            .get::<_, Attestation>(&DataKey::TieredAttestation(user, tier))
        {
            Some(record) => record.revoked_at == 0,
            None => false,
        }
    }

    /// Expiry-aware verification check. Kept for backwards compatibility;
    /// behaves exactly like [`is_valid_and_unexpired`].
    pub fn is_verified(env: Env, user: Address, tier: KycTier) -> bool {
        Self::is_valid_and_unexpired(env, user, tier)
    }

    /// Returns the highest verified tier for `user`, or `None` if no tier is verified.
    ///
    /// Uses the expiry-aware [`is_valid_and_unexpired`] check.
    pub fn get_highest_tier(env: Env, user: Address) -> Option<KycTier> {
        for tier in [KycTier::Business, KycTier::Enhanced, KycTier::Basic] {
            if Self::is_valid_and_unexpired(env.clone(), user.clone(), tier) {
                return Some(tier);
            }
        }
        None
    }

    /// Revoke attestations for multiple users atomically.
    ///
    /// Only the admin may call this. Skips users with no active attestation
    /// rather than panicking, to allow partial-valid batches.
    ///
    /// # Arguments
    /// * `admin` — Must match the admin set during `initialize`.
    /// * `users` — List of Stellar addresses to revoke.
    pub fn revoke_batch(env: Env, admin: Address, users: soroban_sdk::Vec<Address>) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        let now = env.ledger().timestamp();
        for user in users.iter() {
            for tier in [KycTier::Basic, KycTier::Enhanced, KycTier::Business] {
                if Self::revoke_record(&env, &user, tier, now) {
                    env.events()
                        .publish((Symbol::new(&env, "KycRevoked"),), (user.clone(), tier));
                }
            }
        }
    }

    /// Revoke a batch of `(user, tier)` attestations in a single invocation.
    ///
    /// Only the admin may call this. Missing or already-revoked entries are
    /// skipped silently, while a batch larger than 50 entries panics.
    pub fn batch_revoke(
        env: Env,
        admin: Address,
        revocations: soroban_sdk::Vec<(Address, KycTier)>,
    ) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        if revocations.len() > 50 {
            panic!("Batch size exceeds maximum of 50");
        }

        let now = env.ledger().timestamp();
        let mut revoked_count = 0u32;

        for (user, tier) in revocations.iter() {
            if !Self::revoke_record(&env, &user, tier, now) {
                continue;
            }
            revoked_count += 1;

            env.events()
                .publish((Symbol::new(&env, "KycRevoked"),), (user.clone(), tier));
            env.events().publish(
                (Symbol::new(&env, "AttestationRevoked"),),
                AttestationRevoked {
                    user: user.clone(),
                    tier,
                },
            );
        }

        env.events().publish(
            (Symbol::new(&env, "BatchRevocationCompleted"),),
            BatchRevocationCompleted {
                count: revoked_count,
                admin: admin.clone(),
                timestamp: now,
            },
        );
    }

    /// Return the full attestation record for `user` and `tier`, or panic if none exists.
    ///
    /// # Arguments
    /// * `user` — Stellar address to look up.
    /// * `tier` — KYC tier to look up.
    pub fn get_attestation(env: Env, user: Address, tier: KycTier) -> Attestation {
        env.storage()
            .persistent()
            .get(&DataKey::TieredAttestation(user, tier))
            .expect("no attestation found for user and tier")
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

/* … truncated 1568 chars — edit only what you need near the top … */

mod governance;
pub use governance::{CONTRACT_VERSION, UPGRADE_TIMELOCK_SECS};
    fn assert_admin(env: &Env, caller: &Address) {
        let stored: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if caller != &stored {
            panic!("unauthorized: caller is not admin");
        }
    }

    /// Mark the `(user, tier)` attestation revoked, keeping the revocation
    /// evidence and legacy mirrors in sync with `revoke`. Returns `false` when
    /// there is no active attestation to revoke.
    fn revoke_record(env: &Env, user: &Address, tier: KycTier, now: u64) -> bool {
        let key = DataKey::TieredAttestation(user.clone(), tier);
        let mut record: Attestation = match env.storage().persistent().get(&key) {
            Some(record) => record,
            None => return false,
        };
        if record.revoked_at != 0 {
            return false;
        }

        record.revoked_at = now;
        record.last_revoked_at = now;
        record.revocation_count = record.revocation_count.saturating_add(1);
        env.storage().persistent().set(&key, &record);
        env.storage()
            .persistent()
            .set(&DataKey::Attestation(user.clone()), &record);
        env.storage()
            .persistent()
            .set(&DataKey::AttestationByTier(user.clone(), tier), &record);
        true
    }
}
