#![no_std]

//! # KYC Attestation Contract
//!
//! On-chain KYC attestation for AfriPay. Stores a SHA-256 hash of the user's
//! KYC data — never raw PII. Any Stellar ecosystem participant can call
//! [`is_valid_and_unexpired`] to check a wallet's KYC status without trusting
//! AfriPay's centralized database.
//!
//! ## Access control
//! - `attest`, `revoke`, `batch_revoke`, `migrate`, `set_max_validity`,
//!   and admin-rotation methods — admin only
//! - `is_valid_and_unexpired`, `has_ever_attested`, `is_verified`,
//!   `get_attestation`, `get_highest_tier`, `get_max_validity` — public
//!
//! ## Expiry and max validity
//! - [`is_valid_and_unexpired`] is the **expiry-aware** check: it returns `true`
//!   only when an attestation exists, has not been revoked, **and** has not
//!   expired. All fund-gating decisions MUST use this variant.
//! - [`has_ever_attested`] is the **non-expiry-aware** check: it returns `true`
//!   when an attestation exists and has not been revoked, **ignoring expiry**.
//!   It is retained only for historical/audit purposes and MUST NOT be used to
//!   gate fund-moving actions.
//! - Each tier has an admin-configurable max validity in seconds. When a tier's
//!   max validity is configured (> 0), attestations for that tier must have a
//!   non-zero `expires_at` and may not expire later than `now + max_validity`.
//!   A max validity of 0 means unlimited (no expiry required).
//!
//! ## Storage layout
//! - [`DataKey::TieredAttestation`] is the **single source of truth** for an
//!   attestation. Every reader and writer goes through the private
//!   `load_attestation` / `store_attestation` helpers, which only touch this
//!   key.
//! - [`DataKey::Attestation`] and [`DataKey::AttestationByTier`] are legacy
//!   keys from an older layout. They are no longer written; [`migrate`] copies
//!   any `AttestationByTier`-only records into `TieredAttestation` and then
//!   deletes both legacy keys.

use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, Env, Symbol};

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_events;

// ── TTL policy ────────────────────────────────────────────────────────────────
//
// Instance storage (Admin, pending admin proposal, etc.) is bumped on every
// entry point. Persistent attestation records are bumped whenever they are read
// or written. Amounts are expressed in ledgers (~5s each): ~30 days for the
// bump, ~7 days threshold.

/// Ledgers to extend instance storage by when it falls below the threshold.
pub const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
/// Bump instance storage once its remaining TTL drops below this (~7 days).
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = 120_960;
/// Ledgers to extend persistent attestation records by.
pub const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;
/// Bump persistent records once their remaining TTL drops below this (~7 days).
pub const PERSISTENT_LIFETIME_THRESHOLD: u32 = 120_960;

/// Minimum delay between proposing and accepting an admin rotation (24 hours).
pub const ADMIN_ROTATION_DELAY_SECS: u64 = 24 * 60 * 60;

// ── Storage keys ──────────────────────────────────────────────────────────────

/// KYC tier. Defined once in the shared `afripay-types` crate (SC-214) so
/// every contract that passes a tier across a contract boundary uses the same
/// encoding.
pub use afripay_types::KycTier;

#[derive(Debug)]
#[contracttype]
pub enum DataKey {
    Admin,
    PendingAdmin,
    /// Single source of truth for an attestation.
    TieredAttestation(Address, KycTier),
    /// Legacy tier-agnostic key. No longer written; removed by `migrate`.
    Attestation(Address),
    /// Legacy per-tier key. No longer written; removed by `migrate`.
    AttestationByTier(Address, KycTier),
    /// Maximum validity period (seconds) for attestations of a tier.
    /// A value of 0 means unlimited (no expiry required).
    MaxValiditySecs(KycTier),
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

#[derive(Debug, Clone)]
#[contracttype]
pub struct PendingAdmin {
    pub new_admin: Address,
    pub eta: u64,
}

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

#[derive(Debug, Clone)]
#[contracttype]
pub struct Initialized {
    pub admin: Address,
    pub timestamp: u64,
}

/// Payload of the `("kyc_attested", user, tier)` event.
#[derive(Debug, Clone)]
#[contracttype]
pub struct KycAttestedEvent {
    pub admin: Address,
    pub kyc_hash: Bytes,
    pub attested_at: u64,
    pub expires_at: u64,
    pub is_renewal: bool,
}

/// Payload of the `("kyc_revoked", user, tier)` event.
#[derive(Debug, Clone)]
#[contracttype]
pub struct KycRevokedEvent {
    pub admin: Address,
    pub revoked_at: u64,
    pub revocation_count: u32,
}

/// Payload of the `("kyc_batch_revoked",)` event.
#[derive(Debug, Clone)]
#[contracttype]
pub struct KycBatchRevokedEvent {
    pub admin: Address,
    pub count: u32,
}

/// Payload of the `("MaxValidityUpdated", tier)` event.
#[derive(Debug, Clone)]
#[contracttype]
pub struct MaxValidityUpdatedEvent {
    pub admin: Address,
    pub max_validity_secs: u64,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct KycAttestationContract;

#[contractimpl]
impl KycAttestationContract {
    /// Initialise the contract. Must be called once.
    ///
    /// Requires the `admin` address to authorise the call so the contract
    /// cannot be front-run between deploy and initialisation.
    pub fn initialize(env: Env, admin: Address) {
        Self::bump_instance(&env);
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);

        env.events().publish(
            (Symbol::new(&env, "Initialized"),),
            Initialized {
                admin,
                timestamp: env.ledger().timestamp(),
            },
        );
    }

    /// Propose a new admin. The first step of two-step admin rotation.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        if new_admin == admin {
            panic!("new admin must differ from current admin");
        }

        let eta = env
            .ledger()
            .timestamp()
            .saturating_add(ADMIN_ROTATION_DELAY_SECS);
        let pending = PendingAdmin {
            new_admin: new_admin.clone(),
            eta,
        };
        env.storage().instance().set(&DataKey::PendingAdmin, &pending);

        env.events().publish(
            (Symbol::new(&env, "AdminProposed"),),
            (admin, new_admin, eta),
        );
    }

    /// Accept a pending admin proposal. The second step of two-step rotation.
    pub fn accept_admin(env: Env, new_admin: Address) {
        Self::bump_instance(&env);
        new_admin.require_auth();

        let pending: PendingAdmin = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .expect("no pending admin proposal");
        if pending.new_admin != new_admin {
            panic!("unauthorized: caller is not the pending admin");
        }
        if env.ledger().timestamp() < pending.eta {
            panic!("admin rotation delay has not elapsed");
        }

        let old: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage().instance().remove(&DataKey::PendingAdmin);

        env.events()
            .publish((Symbol::new(&env, "AdminChanged"),), (old, new_admin));
    }

    /// Cancel a pending admin proposal. Only the current admin may call this.
    pub fn cancel_admin_proposal(env: Env, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.events()
            .publish((Symbol::new(&env, "AdminProposalCancelled"),), (admin,));
    }

    /// Return the current admin address.
    pub fn get_admin(env: Env) -> Address {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }

    /// Return the pending admin proposal, if any.
    pub fn get_pending_admin(env: Env) -> Option<PendingAdmin> {
        Self::bump_instance(&env);
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    /// Set the maximum attestation validity (seconds) for `tier`.
    ///
    /// `max_validity_secs == 0` means unlimited (attestations may use
    /// `expires_at == 0`). A positive value requires attestations for the tier
    /// to have a bounded expiry not exceeding `now + max_validity_secs`.
    pub fn set_max_validity(env: Env, admin: Address, tier: KycTier, max_validity_secs: u64) {
        Self::bump_instance(&env);
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        env.storage()
            .instance()
            .set(&DataKey::MaxValiditySecs(tier), &max_validity_secs);

        env.events().publish(
            (Symbol::new(&env, "MaxValidityUpdated"), tier),
            MaxValidityUpdatedEvent {
                admin,
                max_validity_secs,
            },
        );
    }

    /// Return the maximum attestation validity (seconds) for `tier`.
    ///
    /// Returns 0 when no limit is configured (unlimited).
    pub fn get_max_validity(env: Env, tier: KycTier) -> u64 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::MaxValiditySecs(tier))
            .unwrap_or(0)
    }

    /// Record a KYC attestation for `user`.
    ///
    /// Only the admin may call this. Panics if the user already has an active
    /// (non-revoked, non-expired) attestation. Re-attesting a revoked or
    /// expired attestation is allowed.
    ///
    /// # Arguments
    /// * `admin`      — Must match the admin set during `initialize`.
    /// * `user`       — Stellar address of the verified user.
    /// * `tier`       — KYC tier being attested.
    /// * `kyc_hash`   — SHA-256 hash of the KYC document bundle. Never raw PII.
    /// * `expires_at` — Ledger timestamp after which the attestation expires.
    ///                  Pass 0 only when the tier's max validity is unlimited.
    pub fn attest(
        env: Env,
        admin: Address,
        user: Address,
        tier: KycTier,
        kyc_hash: Bytes,
        expires_at: u64,
    ) {
        Self::bump_instance(&env);
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        if kyc_hash.len() == 0 {
            panic!("kyc_hash must not be empty");
        }

        let now = env.ledger().timestamp();
        if expires_at != 0 && expires_at <= now {
            panic!("expires_at must be greater than current timestamp");
        }

        let max_validity = Self::max_validity(&env, tier);
        if max_validity != 0 {
            if expires_at == 0 {
                panic!("expires_at must be set when tier max validity is configured");
            }
            let max_expires_at = now.saturating_add(max_validity);
            if expires_at > max_expires_at {
                panic!("expires_at exceeds tier max validity");
            }
        }

        // Re-attestation is only permitted when the existing attestation is no
        // longer active (revoked or expired). An active attestation must be
        // explicitly revoked first.
        let (revocation_count, last_revoked_at, is_renewal) =
            if let Some(existing) = Self::load_attestation(&env, &user, tier) {
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
            kyc_hash: kyc_hash.clone(),
            attested_at: now,
            revoked_at: 0,
            expires_at,
            revocation_count,
            last_revoked_at,
        };
        Self::store_attestation(&env, &user, tier, &record);

        env.events().publish(
            (Symbol::new(&env, "kyc_attested"), user, tier),
            KycAttestedEvent {
                admin,
                kyc_hash,
                attested_at: now,
                expires_at,
                is_renewal,
            },
        );
    }

    /// Revoke an existing attestation for `user` and `tier`.
    pub fn revoke(env: Env, admin: Address, user: Address, tier: KycTier) {
        Self::bump_instance(&env);
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        let now = env.ledger().timestamp();
        let record = Self::revoke_record(&env, &user, tier, now)
            .expect("no attestation found for user and tier");
        if record.revoked_at != now {
            // Should not happen, but keeps intent explicit.
        }

        env.events().publish(
            (Symbol::new(&env, "kyc_revoked"), user, tier),
            KycRevokedEvent {
                admin,
                revoked_at: now,
                revocation_count: record.revocation_count,
            },
        );
    }

    /// Returns `true` if `user` has a current, non-revoked, non-expired KYC
    /// attestation for `tier`.
    pub fn is_valid_and_unexpired(env: Env, user: Address, tier: KycTier) -> bool {
        Self::bump_instance(&env);
        match Self::load_attestation(&env, &user, tier) {
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
    pub fn has_ever_attested(env: Env, user: Address, tier: KycTier) -> bool {
        Self::bump_instance(&env);
        match Self::load_attestation(&env, &user, tier) {
            Some(record) => record.revoked_at == 0,
            None => false,
        }
    }

    /// Expiry-aware verification check. Kept for backwards compatibility.
    pub fn is_verified(env: Env, user: Address, tier: KycTier) -> bool {
        Self::is_valid_and_unexpired(env, user, tier)
    }

    /// Returns the highest verified tier for `user`, or `None` if no tier is verified.
    pub fn get_highest_tier(env: Env, user: Address) -> Option<KycTier> {
        Self::bump_instance(&env);
        for tier in [KycTier::Business, KycTier::Enhanced, KycTier::Basic] {
            if Self::is_valid_and_unexpired_inner(&env, &user, tier) {
                return Some(tier);
            }
        }
        None
    }

    /// Revoke attestations for multiple users atomically (all tiers).
    pub fn revoke_batch(env: Env, admin: Address, users: soroban_sdk::Vec<Address>) {
        Self::bump_instance(&env);
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        let now = env.ledger().timestamp();
        let mut revoked_count = 0u32;
        for user in users.iter() {
            for tier in [KycTier::Basic, KycTier::Enhanced, KycTier::Business] {
                if let Some(record) = Self::revoke_record(&env, &user, tier, now) {
                    revoked_count += 1;
                    env.events().publish(
                        (Symbol::new(&env, "kyc_revoked"), user.clone(), tier),
                        KycRevokedEvent {
                            admin: admin.clone(),
                            revoked_at: now,
                            revocation_count: record.revocation_count,
                        },
                    );
                }
            }
        }

        env.events().publish(
            (Symbol::new(&env, "kyc_batch_revoked"),),
            KycBatchRevokedEvent { admin, count: revoked_count },
        );
    }

    /// Revoke a batch of `(user, tier)` attestations in a single invocation.
    pub fn batch_revoke(
        env: Env,
        admin: Address,
        revocations: soroban_sdk::Vec<(Address, KycTier)>,
    ) {
        Self::bump_instance(&env);
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        if revocations.len() > 50 {
            panic!("Batch size exceeds maximum of 50");
        }

        let now = env.ledger().timestamp();
        let mut revoked_count = 0u32;

        for (user, tier) in revocations.iter() {
            let record = match Self::revoke_record(&env, &user, tier, now) {
                Some(record) => record,
                None => continue,
            };
            revoked_count += 1;

            env.events().publish(
                (Symbol::new(&env, "kyc_revoked"), user.clone(), tier),
                KycRevokedEvent {
                    admin: admin.clone(),
                    revoked_at: now,
                    revocation_count: record.revocation_count,
                },
            );
            env.events().publish(
                (Symbol::new(&env, "AttestationRevoked"),),
                AttestationRevoked {
                    user: user.clone(),
                    tier,
                },
            );
        }

        env.events().publish(
            (Symbol::new(&env, "kyc_batch_revoked"),),
            KycBatchRevokedEvent {
                admin: admin.clone(),
                count: revoked_count,
            },
        );
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
    pub fn get_attestation(env: Env, user: Address, tier: KycTier) -> Attestation {
        Self::bump_instance(&env);
        Self::load_attestation(&env, &user, tier)
            .expect("no attestation found for user and tier")
    }

    /// One-time migration from the legacy three-key layout to the single
    /// `TieredAttestation(user, tier)` key for the provided users.
    ///
    /// Safe to call more than once.
    pub fn migrate(env: Env, admin: Address, users: soroban_sdk::Vec<Address>) {
        Self::bump_instance(&env);
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        for user in users.iter() {
            for tier in [KycTier::Basic, KycTier::Enhanced, KycTier::Business] {
                let legacy_key = DataKey::AttestationByTier(user.clone(), tier);
                if let Some(legacy) = env
                    .storage()
                    .persistent()
                    .get::<_, Attestation>(&legacy_key)
                {
                    Self::bump_persistent(&env, &legacy_key);
                    if Self::load_attestation(&env, &user, tier).is_none() {
                        Self::store_attestation(&env, &user, tier, &legacy);
                    }
                }
                env.storage().persistent().remove(&legacy_key);
            }
            env.storage()
                .persistent()
                .remove(&DataKey::Attestation(user.clone()));
        }
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

/* … truncated 1568 chars — edit only what you need near the top … */

// SC-214: this contract implements its interface from `afripay-types`, so the
// compiler checks the exported signature against the one consumers call.
// Changing the entry point without updating the shared trait breaks this build;
// updating the trait breaks every consumer still using the old signature.
impl afripay_types::KycAttestationInterface for KycAttestationContract {
    fn is_valid_and_unexpired(env: Env, user: Address, tier: KycTier) -> bool {
        KycAttestationContract::is_valid_and_unexpired(env, user, tier)
    }
}

mod governance;
pub use governance::{CONTRACT_VERSION, UPGRADE_TIMELOCK_SECS};
    fn assert_admin(env: &Env, caller: &Address) {
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        if caller != &stored {
            panic!("unauthorized: caller is not admin");
        }
    }

    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }

    fn bump_persistent(env: &Env, key: &DataKey) {
        env.storage().persistent().extend_ttl(
            key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
    }

    fn max_validity(env: &Env, tier: KycTier) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::MaxValiditySecs(tier))
            .unwrap_or(0)
    }

    fn load_attestation(env: &Env, user: &Address, tier: KycTier) -> Option<Attestation> {
        let key = DataKey::TieredAttestation(user.clone(), tier);
        let record = env.storage().persistent().get::<_, Attestation>(&key)?;
        Self::bump_persistent(env, &key);
        Some(record)
    }

    fn store_attestation(env: &Env, user: &Address, tier: KycTier, record: &Attestation) {
        let key = DataKey::TieredAttestation(user.clone(), tier);
        env.storage().persistent().set(&key, record);
        Self::bump_persistent(env, &key);
    }

    fn is_valid_and_unexpired_inner(env: &Env, user: &Address, tier: KycTier) -> bool {
        match Self::load_attestation(env, user, tier) {
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

    fn revoke_record(env: &Env, user: &Address, tier: KycTier, now: u64) -> Option<Attestation> {
        let key = DataKey::TieredAttestation(user.clone(), tier);
        let mut record: Attestation = env.storage().persistent().get(&key)?;
        Self::bump_persistent(env, &key);
        if record.revoked_at != 0 {
            return None;
        }

        record.revoked_at = now;
        record.last_revoked_at = now;
        record.revocation_count = record.revocation_count.saturating_add(1);
        env.storage().persistent().set(&key, &record);
        Self::bump_persistent(env, &key);
        Some(record)
    }
}
