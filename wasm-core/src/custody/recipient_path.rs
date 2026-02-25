//! Recipient Path Credential Generation
//!
//! Generates the credential set for each recipient authorization path.
//! Each path consists of three components that must converge:
//!   AP_j = (SA_j, UserCred_j, AdminFactor_j)
//!
//! The composite credential is built as:
//!   Cred_composite = Argon2id(UserCred_j || AdminFactor_j)
//!
//! Note: The actual Seal/Unseal operations use acegf-core from dev.yallet-chrome.
//! This module provides the credential generation and composition logic.

use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use super::admin_factor::{self, ContextTuple, ADMIN_FACTOR_SIZE};

/// Number of words in the UserCred passphrase (custom word list, not BIP-39)
const USER_CRED_WORD_COUNT: usize = 6;

#[derive(Error, Debug)]
pub enum PathError {
    #[error("invalid recipient index: must be > 0")]
    InvalidIndex,
    #[error("invalid UserCred: must not be empty")]
    EmptyUserCred,
    #[error("invalid AdminFactor length: expected {ADMIN_FACTOR_SIZE}, got {0}")]
    InvalidAdminFactorLength(usize),
    #[error("AdminFactor error: {0}")]
    AdminFactor(#[from] admin_factor::AdminFactorError),
}

/// Complete credentials for one recipient authorization path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipientCredentials {
    /// Recipient index (1-based)
    pub index: u32,
    /// Human-readable label (e.g., "Partner A", "Department B")
    pub label: String,
    /// UserCred: passphrase for this recipient (given to recipient)
    pub user_cred: String,
    /// UserCred raw entropy bytes (hex)
    pub user_cred_entropy_hex: String,
    /// AdminFactor: 256-bit key (given to authorities via Shamir)
    pub admin_factor_hex: String,
    /// Context tuple for HKDF isolation
    pub context: ContextTuple,
}

/// Metadata stored on-chain / locally about a recipient path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipientPathInfo {
    pub index: u32,
    pub label: String,
    /// SHA-256 hash of the AdminFactor (for verification, not the factor itself)
    pub admin_factor_hash: String,
    pub context: ContextTuple,
    /// Arweave TX IDs
    pub trigger_nft_tx: Option<String>,
    pub recovery_nft_tx: Option<String>,
    /// Authority IDs bound to this path
    pub authority_ids: Vec<String>,
    /// tlock deadline (drand round number)
    pub tlock_round: Option<u64>,
    /// Path status
    pub status: PathStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PathStatus {
    Active,
    Superseded,
    Triggered,
    Released,
    Activated,
}

/// Word list for generating human-readable credentials.
/// 256 unique words → 8 bits per word → 6 words × 8 bits = 48 bits entropy.
/// (~281 trillion combinations — sufficient for a secondary credential.)
const WORD_LIST: &[&str] = &[
    // Block 1 (64 words)
    "apple", "brave", "cloud", "dance", "eagle", "flame", "grace", "heart",
    "ivory", "jewel", "karma", "light", "maple", "noble", "ocean", "pearl",
    "quest", "river", "solar", "tiger", "ultra", "vivid", "water", "xenon",
    "yield", "zebra", "amber", "bloom", "cedar", "dream", "ember", "frost",
    "globe", "haven", "index", "joker", "kneel", "lunar", "mango", "nexus",
    "orbit", "prism", "quilt", "realm", "stone", "torch", "unity", "vault",
    "waltz", "xeric", "youth", "zonal", "alpha", "brisk", "coral", "delta",
    "epoch", "forge", "grain", "hover", "ionic", "jolly", "kappa", "lodge",
    // Block 2 (64 words)
    "acorn", "badge", "cabin", "denim", "elbow", "fable", "gamma", "hazel",
    "igloo", "jelly", "knife", "lemur", "magic", "nerve", "oasis", "piano",
    "queen", "radar", "satin", "tempo", "umbra", "vigor", "whale", "xerus",
    "yacht", "zinc",  "asset", "baker", "candy", "derby", "elite", "flint",
    "grape", "hobby", "inbox", "juice", "kayak", "latch", "mocha", "night",
    "olive", "plaza", "quota", "robin", "scope", "trend", "union", "venus",
    "wheat", "yeast", "zones", "arrow", "blaze", "chief", "dense", "entry",
    "flora", "ghost", "honey", "irony", "knack", "lilac", "medal", "novel",
    // Block 3 (64 words)
    "oxide", "phase", "quake", "ridge", "sigma", "trunk", "usher", "vapor",
    "wings", "yards", "audit", "bench", "charm", "drift", "ether", "forum",
    "glyph", "haste", "joust", "knead", "lumen", "marsh", "niche", "omega",
    "pixel", "query", "reign", "slate", "thyme", "venom", "wrist", "yucca",
    "aegis", "braid", "crest", "dwarf", "exude", "fjord", "glade", "helix",
    "impel", "joule", "kudos", "lyric", "motif", "nadir", "onset", "plume",
    "quirk", "rogue", "spire", "trove", "umber", "xerox", "yearn", "zilch",
    "azure", "basil", "cleft", "drape", "elfin", "finch", "guise", "hutch",
    // Block 4 (64 words)
    "inlet", "jaunt", "knoll", "lever", "mirth", "notch", "optic", "perch",
    "quill", "roost", "swift", "talon", "uncut", "valet", "whirl", "xylem",
    "yodel", "zesty", "adept", "birch", "clasp", "diver", "evoke", "flair",
    "graft", "heron", "infer", "joint", "koala", "llama", "minor", "nylon",
    "outer", "patch", "quart", "relic", "shrub", "trace", "urban", "viola",
    "wager", "yokel", "abode", "bonus", "creed", "dodge", "easel", "femur",
    "grief", "hymns", "issue", "jabot", "kiosk", "libel", "mural", "niece",
    "okapi", "paste", "quash", "rover", "stoic", "tunic", "usurp", "verge",
]; // 256 words total

/// Generate a human-readable passphrase from random entropy.
fn generate_passphrase(word_count: usize) -> (String, Vec<u8>) {
    let mut entropy = vec![0u8; word_count * 2]; // 2 bytes per word = 16 bits of choice
    rand::thread_rng().fill_bytes(&mut entropy);

    let words: Vec<&str> = entropy
        .chunks(2)
        .take(word_count)
        .map(|chunk| {
            let idx = ((chunk[0] as usize) << 8 | chunk[1] as usize) % WORD_LIST.len();
            WORD_LIST[idx]
        })
        .collect();

    (words.join("-"), entropy)
}

/// Generate a complete set of credentials for a recipient path.
///
/// # Arguments
/// * `index` - Recipient index (1-based)
/// * `label` - Human-readable label (e.g., "Partner A")
///
/// # Returns
/// `RecipientCredentials` containing UserCred, AdminFactor, and context.
pub fn generate_recipient_credentials(
    index: u32,
    label: &str,
) -> Result<RecipientCredentials, PathError> {
    if index == 0 {
        return Err(PathError::InvalidIndex);
    }

    // Generate UserCred (passphrase)
    let (user_cred, user_cred_entropy) = generate_passphrase(USER_CRED_WORD_COUNT);

    // Generate AdminFactor (256-bit random)
    let admin_factor = admin_factor::generate_admin_factor();

    // Build context tuple for HKDF isolation
    let context = ContextTuple::for_recipient(index);

    Ok(RecipientCredentials {
        index,
        label: label.to_string(),
        user_cred,
        user_cred_entropy_hex: hex::encode(&user_cred_entropy),
        admin_factor_hex: hex::encode(admin_factor),
        context,
    })
}

/// Build a composite credential from UserCred and AdminFactor.
///
/// composite = UserCred_bytes || AdminFactor_bytes  (concatenation, NOT hashed)
///
/// Note: This function returns the raw concatenation. The actual KDF
/// (Argon2id) is applied by acegf-core's seal/unseal functions, which
/// receive this concatenation as input.
///
/// # Arguments
/// * `user_cred` - The recipient's passphrase bytes
/// * `admin_factor` - The AdminFactor bytes (32 bytes)
///
/// # Returns
/// The composite credential bytes (input to Argon2id in acegf-core).
pub fn build_composite_credential(
    user_cred: &[u8],
    admin_factor: &[u8],
) -> Result<Vec<u8>, PathError> {
    if user_cred.is_empty() {
        return Err(PathError::EmptyUserCred);
    }
    if admin_factor.len() != ADMIN_FACTOR_SIZE {
        return Err(PathError::InvalidAdminFactorLength(admin_factor.len()));
    }

    // Concatenate: UserCred || AdminFactor
    // This concatenation is the input to Argon2id in acegf-core
    let mut composite = Vec::with_capacity(user_cred.len() + admin_factor.len());
    composite.extend_from_slice(user_cred);
    composite.extend_from_slice(admin_factor);
    Ok(composite)
}

/// Amount in composite is 8 bytes big-endian u64 (matches blob format).
const AMOUNT_COMPOSITE_LEN: usize = 8;

/// Build a composite credential from UserCred, AdminFactor, and amount.
///
/// composite = UserCred_bytes || AdminFactor_bytes || amount_u64_be
/// Used when amount is bound in the blob; Seal/Unseal must use the same composite.
/// Use the nominal/blob amount here; the claim contract transfers min(signed_amount, remaining)
/// so rounding (e.g. 9.999... remaining) does not require a different key.
pub fn build_composite_credential_with_amount(
    user_cred: &[u8],
    admin_factor: &[u8],
    amount: u64,
) -> Result<Vec<u8>, PathError> {
    if user_cred.is_empty() {
        return Err(PathError::EmptyUserCred);
    }
    if admin_factor.len() != ADMIN_FACTOR_SIZE {
        return Err(PathError::InvalidAdminFactorLength(admin_factor.len()));
    }

    let mut composite = Vec::with_capacity(user_cred.len() + admin_factor.len() + AMOUNT_COMPOSITE_LEN);
    composite.extend_from_slice(user_cred);
    composite.extend_from_slice(admin_factor);
    composite.extend_from_slice(&amount.to_be_bytes());
    Ok(composite)
}

/// Compute a fingerprint (SHA-256 hash) of an AdminFactor for verification.
/// This hash can be stored publicly without revealing the AdminFactor.
pub fn admin_factor_fingerprint(admin_factor: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(admin_factor);
    hex::encode(hasher.finalize())
}

/// Create path info metadata (for local storage / display).
pub fn create_path_info(
    creds: &RecipientCredentials,
    authority_ids: Vec<String>,
) -> RecipientPathInfo {
    // H-09 FIX: Propagate hex decode failure instead of silently using empty bytes
    let af_bytes = hex::decode(&creds.admin_factor_hex)
        .expect("RecipientCredentials.admin_factor_hex must be valid hex (generated internally)");
    RecipientPathInfo {
        index: creds.index,
        label: creds.label.clone(),
        admin_factor_hash: admin_factor_fingerprint(&af_bytes),
        context: creds.context.clone(),
        trigger_nft_tx: None,
        recovery_nft_tx: None,
        authority_ids,
        tlock_round: None,
        status: PathStatus::Active,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_credentials() {
        let creds = generate_recipient_credentials(1, "Partner A").unwrap();
        assert_eq!(creds.index, 1);
        assert_eq!(creds.label, "Partner A");
        assert!(!creds.user_cred.is_empty());
        assert!(creds.user_cred.contains('-')); // hyphen-separated words
        assert_eq!(hex::decode(&creds.admin_factor_hex).unwrap().len(), 32);
    }

    #[test]
    fn test_different_indices_different_contexts() {
        let c1 = generate_recipient_credentials(1, "A").unwrap();
        let c2 = generate_recipient_credentials(2, "B").unwrap();
        assert_ne!(c1.context.to_info_bytes(), c2.context.to_info_bytes());
    }

    #[test]
    fn test_build_composite_credential() {
        let user_cred = b"brave-ocean-tiger-pearl-amber-frost";
        let admin_factor = [0xAB; 32];
        let composite = build_composite_credential(user_cred, &admin_factor).unwrap();
        assert_eq!(composite.len(), user_cred.len() + 32);
        assert_eq!(&composite[..user_cred.len()], user_cred);
        assert_eq!(&composite[user_cred.len()..], &admin_factor);
    }

    #[test]
    fn test_empty_user_cred_rejected() {
        let admin_factor = [0u8; 32];
        assert!(build_composite_credential(b"", &admin_factor).is_err());
    }

    #[test]
    fn test_wrong_admin_factor_length() {
        assert!(build_composite_credential(b"test", &[0u8; 16]).is_err());
    }

    #[test]
    fn test_build_composite_credential_with_amount() {
        let user_cred = b"brave-ocean-tiger";
        let admin_factor = [0xABu8; 32];
        let amount = 500_000_000u64;
        let composite = build_composite_credential_with_amount(user_cred, &admin_factor, amount).unwrap();
        assert_eq!(composite.len(), user_cred.len() + 32 + 8);
        assert_eq!(&composite[..user_cred.len()], user_cred);
        assert_eq!(&composite[user_cred.len()..user_cred.len() + 32], &admin_factor);
        assert_eq!(u64::from_be_bytes(composite[user_cred.len() + 32..].try_into().unwrap()), amount);
    }

    #[test]
    fn test_index_zero_rejected() {
        assert!(generate_recipient_credentials(0, "invalid").is_err());
    }

    #[test]
    fn test_admin_factor_fingerprint() {
        let af = [0xAA; 32];
        let fp1 = admin_factor_fingerprint(&af);
        let fp2 = admin_factor_fingerprint(&af);
        assert_eq!(fp1, fp2); // deterministic
        assert_eq!(fp1.len(), 64); // SHA-256 hex

        let af2 = [0xBB; 32];
        let fp3 = admin_factor_fingerprint(&af2);
        assert_ne!(fp1, fp3); // different input → different hash
    }

    #[test]
    fn test_create_path_info() {
        let creds = generate_recipient_credentials(1, "Recipient A").unwrap();
        let info = create_path_info(&creds, vec!["authority_a".to_string(), "authority_b".to_string()]);
        assert_eq!(info.index, 1);
        assert_eq!(info.label, "Recipient A");
        assert_eq!(info.authority_ids.len(), 2);
        assert_eq!(info.status, PathStatus::Active);
        assert!(!info.admin_factor_hash.is_empty());
    }
}
