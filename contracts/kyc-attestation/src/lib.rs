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

/// Maximum number of entries accepted by `revoke_batch` / `batch_revoke`.
const MAX_BATCH_SIZE: u32 = 50;

mod test;

// ── Storage keys ──────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[contracttype]
#[repr(u32)]
pub enum KycTier {
    Basic = 0,
    Enhanced = 1,
    Business = 2,
}

#[contracttype]
pub enum DataKey {
    Admin,
    TieredAttestation(Address, KycTier),
    Attestation(Address),
    AttestationByTier(Address, KycTier),
}

// ── Domain types ──────────────────────────────────────────────────────────────

/// On-chain KYC attestation record.
#[derive(Clone)]
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

#[derive(Clone)]
#[contracttype]
pub struct AttestationRevoked {
    pub user: Address,
    pub tier: KycTier,
}

#[derive(Clone)]
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

    /// Backwards-compatible alias for [`is_valid_and_unexpired`].
    ///
    /// Other contracts and off-chain clients call `is_verified` by name, so it
    /// is kept as part of the public API. It is **expiry-aware** and safe to use
    /// for fund-gating decisions.
    ///
    /// Public — any caller may invoke this.
    ///
    /// # Arguments
    /// * `user` — Stellar address to check.
    /// * `tier` — KYC tier to verify.
    pub fn is_verified(env: Env, user: Address, tier: KycTier) -> bool {
        Self::is_valid_and_unexpired(env, user, tier)
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

    /// Revoke every active tier attestation for each user in `users`.
    ///
    /// Only the admin may call this. Skips users/tiers with no active
    /// attestation rather than panicking, to allow partial-valid batches.
    ///
    /// # Arguments
    /// * `admin` — Must match the admin set during `initialize`.
    /// * `users` — List of Stellar addresses to revoke.
    pub fn revoke_batch(env: Env, admin: Address, users: soroban_sdk::Vec<Address>) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        if users.len() > MAX_BATCH_SIZE {
            panic!("Batch size exceeds maximum of 50");
        }

        let now = env.ledger().timestamp();
        for user in users.iter() {
            for tier in [KycTier::Basic, KycTier::Enhanced, KycTier::Business] {
                Self::revoke_if_active(&env, &user, tier, now);
            }
        }
    }

    /// Revoke a batch of wallet-tier attestations in a single invocation.
    ///
    /// Only the admin may call this. Missing or already-revoked entries are
    /// skipped silently, while a batch larger than 50 entries panics.
    /// Emits a `BatchRevocationCompleted` event with the number revoked.
    pub fn batch_revoke(
        env: Env,
        admin: Address,
        revocations: soroban_sdk::Vec<(Address, KycTier)>,
    ) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        if revocations.len() > MAX_BATCH_SIZE {
            panic!("Batch size exceeds maximum of 50");
        }

        let now = env.ledger().timestamp();
        let mut revoked_count = 0u32;

        for (user, tier) in revocations.iter() {
            if Self::revoke_if_active(&env, &user, tier, now) {
                revoked_count += 1;
                env.events().publish(
                    (Symbol::new(&env, "AttestationRevoked"),),
                    AttestationRevoked {
                        user: user.clone(),
                        tier,
                    },
                );
            }
        }

        env.events().publish(
            (Symbol::new(&env, "BatchRevocationCompleted"),),
            BatchRevocationCompleted {
                count: revoked_count,
                admin,
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

    /// Revoke `user`'s attestation for `tier` if it exists and is still active.
    /// Updates the revocation evidence and legacy mirrors the same way
    /// [`revoke`] does. Returns `true` if a record was revoked.
    fn revoke_if_active(env: &Env, user: &Address, tier: KycTier, now: u64) -> bool {
        let key = DataKey::TieredAttestation(user.clone(), tier);
        let mut record = match env.storage().persistent().get::<_, Attestation>(&key) {
            Some(record) if record.revoked_at == 0 => record,
            _ => return false,
        };

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

        env.events()
            .publish((Symbol::new(env, "KycRevoked"),), (user.clone(), tier));
        true
    }
}
