//! WASM Exports for Custody Module
//!
//! Exposes all custody crypto functions to JavaScript via wasm-bindgen.
//! Follows the same patterns as dev.yallet-chrome/src/wasm.rs:
//! - JsValue for structured returns (via serde)
//! - String for hex-encoded binary data
//! - "error:..." prefix for error strings

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use super::admin_factor::{self, ContextTuple};
use super::blob_amount;
use super::recipient_path;
use super::e2e_crypto;
use super::shamir;

/// Helper to convert a serializable value to JsValue using serde_wasm_bindgen
/// (replaces deprecated JsValue::from_serde).
fn to_js_value<T: Serialize>(value: &T) -> JsValue {
    serde_wasm_bindgen::to_value(value).unwrap_or(JsValue::NULL)
}

// ─── Helper types for JS interop ───

#[derive(Serialize)]
struct WasmError {
    error: bool,
    message: String,
}

#[derive(Serialize)]
struct AdminFactorResult {
    admin_factor_hex: String,
}

#[derive(Serialize)]
struct ShareResult {
    index: u8,
    data_hex: String,
}

#[derive(Serialize)]
struct E2eEncryptResult {
    package_hex: String,
    ephemeral_pubkey_hex: String,
}

#[derive(Serialize)]
struct KeypairResult {
    public_key_hex: String,
    secret_key_hex: String,
}

#[derive(Deserialize)]
struct ShareInput {
    index: u8,
    data_hex: String,
}

fn to_js_error(msg: &str) -> JsValue {
    let err = WasmError {
        error: true,
        message: msg.to_string(),
    };
    to_js_value(&err)
}

// ─── AdminFactor Functions ───

/// Generate a new random AdminFactor (256-bit).
/// Returns: { admin_factor_hex: "..." }
#[wasm_bindgen]
pub fn custody_generate_admin_factor() -> JsValue {
    let af = admin_factor::generate_admin_factor();
    let result = AdminFactorResult {
        admin_factor_hex: hex::encode(af),
    };
    to_js_value(&result)
}

/// Derive a backup encryption key from REV and a personal context.
/// Returns hex-encoded 32-byte key, or "error:..." on failure.
///
/// # Arguments
/// * `rev_hex` - REV as hex string (32 hex chars = 16 bytes UUID)
/// * `recipient_index` - Recipient index for context isolation
#[wasm_bindgen]
pub fn custody_derive_backup_key(rev_hex: &str, recipient_index: u32) -> String {
    let rev = match hex::decode(rev_hex) {
        Ok(v) => v,
        Err(e) => return format!("error:invalid REV hex: {}", e),
    };

    let ctx = ContextTuple::for_recipient(recipient_index);

    match admin_factor::derive_backup_key(&rev, &ctx) {
        Ok(key) => hex::encode(&*key),
        Err(e) => format!("error:{}", e),
    }
}

/// Derive a backup encryption key from REV with institutional context isolation.
/// Returns hex-encoded 32-byte key, or "error:..." on failure.
///
/// Each (entity_id, domain, index) triple produces a cryptographically isolated key,
/// ensuring that different vaults / sub-accounts within the same entity cannot
/// cross-access each other's encrypted AdminFactors.
///
/// # Arguments
/// * `rev_hex`   - REV as hex string (32 hex chars = 16 bytes UUID)
/// * `entity_id` - Organization identifier (e.g., "corp-abc-123")
/// * `domain`    - Vault purpose (e.g., "OperatingFund", "MnAEscrow")
/// * `index`     - Vault index within this entity/domain
#[wasm_bindgen]
pub fn custody_derive_backup_key_institutional(
    rev_hex: &str,
    entity_id: &str,
    domain: &str,
    index: u32,
) -> String {
    let rev = match hex::decode(rev_hex) {
        Ok(v) => v,
        Err(e) => return format!("error:invalid REV hex: {}", e),
    };

    if entity_id.is_empty() {
        return "error:entity_id must not be empty".to_string();
    }
    if domain.is_empty() {
        return "error:domain must not be empty".to_string();
    }

    let ctx = ContextTuple::for_institutional(entity_id, domain, index);

    match admin_factor::derive_backup_key(&rev, &ctx) {
        Ok(key) => hex::encode(&*key),
        Err(e) => format!("error:{}", e),
    }
}

/// Build the ACE-GF core context string for institutional vault key derivation.
///
/// This produces the `context_info` parameter that should be passed to
/// acegf-core's `view_wallet_wasm_with_context()` function. ACE-GF core
/// appends this to each chain's HKDF info label (e.g., "ACEGF-REV32-V1-ED25519-SOLANA:context"),
/// producing cryptographically independent chain keys per vault.
///
/// Returns:
/// - Personal (entity_id="personal"): "" (empty string → backward compatible)
/// - Institutional: "{entity_id}:{domain}:{index}"
///
/// # Arguments
/// * `entity_id` - Organization identifier (e.g., "corp-abc-123", or "personal")
/// * `domain`    - Vault purpose (e.g., "OperatingFund", "MnAEscrow")
/// * `index`     - Vault index within this entity/domain
#[wasm_bindgen]
pub fn custody_build_acegf_context(
    entity_id: &str,
    domain: &str,
    index: u32,
) -> String {
    if entity_id.is_empty() || entity_id == "personal" {
        return String::new();
    }

    let ctx = ContextTuple::for_institutional(entity_id, domain, index);
    ctx.to_acegf_context()
}

/// Encrypt an AdminFactor for backup on Arweave.
/// Returns hex-encoded ciphertext (nonce || encrypted data), or "error:...".
#[wasm_bindgen]
pub fn custody_encrypt_backup(admin_factor_hex: &str, backup_key_hex: &str) -> String {
    let af = match hex::decode(admin_factor_hex) {
        Ok(v) => v,
        Err(e) => return format!("error:invalid AdminFactor hex: {}", e),
    };
    let key = match hex::decode(backup_key_hex) {
        Ok(v) => v,
        Err(e) => return format!("error:invalid backup key hex: {}", e),
    };

    match admin_factor::encrypt_admin_factor_backup(&af, &key) {
        Ok(ct) => hex::encode(ct),
        Err(e) => format!("error:{}", e),
    }
}

/// Decrypt an AdminFactor from an Arweave backup.
/// Returns hex-encoded AdminFactor (32 bytes), or "error:...".
#[wasm_bindgen]
pub fn custody_decrypt_backup(ciphertext_hex: &str, backup_key_hex: &str) -> String {
    let ct = match hex::decode(ciphertext_hex) {
        Ok(v) => v,
        Err(e) => return format!("error:invalid ciphertext hex: {}", e),
    };
    let key = match hex::decode(backup_key_hex) {
        Ok(v) => v,
        Err(e) => return format!("error:invalid backup key hex: {}", e),
    };

    match admin_factor::decrypt_admin_factor_backup(&ct, &key) {
        Ok(af) => hex::encode(af),
        Err(e) => format!("error:{}", e),
    }
}

// ─── Shamir Secret Sharing Functions ───

/// Split a secret into N shares with threshold T.
/// Returns JSON array of { index, data_hex } objects.
///
/// # Arguments
/// * `secret_hex` - Secret to split (hex-encoded)
/// * `total` - Total number of shares (e.g., 3)
/// * `threshold` - Minimum shares to reconstruct (e.g., 2)
#[wasm_bindgen]
pub fn custody_shamir_split(secret_hex: &str, total: u8, threshold: u8) -> JsValue {
    let secret = match hex::decode(secret_hex) {
        Ok(v) => v,
        Err(e) => return to_js_error(&format!("invalid secret hex: {}", e)),
    };

    match shamir::split(&secret, total, threshold) {
        Ok(shares) => {
            let results: Vec<ShareResult> = shares
                .iter()
                .map(|s| ShareResult {
                    index: s.index,
                    data_hex: hex::encode(&s.data),
                })
                .collect();
            to_js_value(&results)
        }
        Err(e) => to_js_error(&e.to_string()),
    }
}

/// Reconstruct a secret from Shamir shares with explicit threshold enforcement.
/// Returns hex-encoded secret, or "error:...".
///
/// # Arguments
/// * `shares_json` - JSON array string: [{"index": 1, "data_hex": "..."}, ...]
/// * `threshold` - Minimum number of shares required (must match the original split threshold)
#[wasm_bindgen]
pub fn custody_shamir_reconstruct(shares_json: &str, threshold: u8) -> String {
    let share_inputs: Vec<ShareInput> = match serde_json::from_str(shares_json) {
        Ok(v) => v,
        Err(e) => return format!("error:invalid shares JSON: {}", e),
    };

    let shares: Result<Vec<shamir::ShamirShare>, _> = share_inputs
        .iter()
        .map(|si| {
            hex::decode(&si.data_hex).map(|data| shamir::ShamirShare {
                index: si.index,
                data,
            })
        })
        .collect();

    let shares = match shares {
        Ok(v) => v,
        Err(e) => return format!("error:invalid share data hex: {}", e),
    };

    match shamir::reconstruct_with_threshold(&shares, threshold) {
        Ok(secret) => hex::encode(secret),
        Err(e) => format!("error:{}", e),
    }
}

// ─── E2E Encryption Functions ───

/// Generate an X25519 keypair for an authority.
/// Returns: { public_key_hex, secret_key_hex }
#[wasm_bindgen]
pub fn custody_generate_keypair() -> JsValue {
    let (pk, sk) = e2e_crypto::generate_x25519_keypair();
    let result = KeypairResult {
        public_key_hex: hex::encode(pk),
        secret_key_hex: hex::encode(sk),
    };
    to_js_value(&result)
}

/// Encrypt a message (AdminFactor share) for an authority.
/// Returns: { package_hex, ephemeral_pubkey_hex }
///
/// # Arguments
/// * `message_hex` - Message to encrypt (hex-encoded)
/// * `authority_pubkey_hex` - Authority's X25519 public key (hex, 64 chars = 32 bytes)
#[wasm_bindgen]
pub fn custody_encrypt_for_authority(message_hex: &str, authority_pubkey_hex: &str) -> JsValue {
    let message = match hex::decode(message_hex) {
        Ok(v) => v,
        Err(e) => return to_js_error(&format!("invalid message hex: {}", e)),
    };
    let pk = match hex::decode(authority_pubkey_hex) {
        Ok(v) => v,
        Err(e) => return to_js_error(&format!("invalid pubkey hex: {}", e)),
    };

    match e2e_crypto::encrypt_for_authority(&message, &pk) {
        Ok(package) => {
            let result = E2eEncryptResult {
                package_hex: hex::encode(package.to_bytes()),
                ephemeral_pubkey_hex: hex::encode(package.ephemeral_pubkey),
            };
            to_js_value(&result)
        }
        Err(e) => to_js_error(&e.to_string()),
    }
}

/// Decrypt a message from a user (AdminFactor share).
/// Returns hex-encoded plaintext, or "error:...".
///
/// # Arguments
/// * `package_hex` - The E2E package (ephemeral_pubkey || nonce || ciphertext+tag)
/// * `authority_secret_hex` - Authority's X25519 secret key (hex)
#[wasm_bindgen]
pub fn custody_decrypt_from_user(package_hex: &str, authority_secret_hex: &str) -> String {
    let package = match hex::decode(package_hex) {
        Ok(v) => v,
        Err(e) => return format!("error:invalid package hex: {}", e),
    };
    let sk = match hex::decode(authority_secret_hex) {
        Ok(v) => v,
        Err(e) => return format!("error:invalid secret key hex: {}", e),
    };

    match e2e_crypto::decrypt_from_user(&package, &sk) {
        Ok(plaintext) => hex::encode(plaintext),
        Err(e) => format!("error:{}", e),
    }
}

// ─── Recipient Path Functions ───

/// Generate credentials for a new recipient path.
/// Returns: { index, label, user_cred, user_cred_entropy_hex, admin_factor_hex, context }
///
/// # Arguments
/// * `index` - Recipient index (1-based)
/// * `label` - Human-readable label (e.g., "Partner A")
#[wasm_bindgen]
pub fn custody_generate_path(index: u32, label: &str) -> JsValue {
    match recipient_path::generate_recipient_credentials(index, label) {
        Ok(creds) => {
            to_js_value(&creds)
        }
        Err(e) => to_js_error(&e.to_string()),
    }
}

/// Build a composite credential from UserCred and AdminFactor.
/// Returns hex-encoded composite bytes (input to Argon2id), or "error:...".
///
/// The composite is: UserCred_bytes || AdminFactor_bytes
/// Caller should pass this to acegf-core's Argon2id for the actual KDF.
#[wasm_bindgen]
pub fn custody_build_composite(user_cred: &str, admin_factor_hex: &str) -> String {
    let af = match hex::decode(admin_factor_hex) {
        Ok(v) => v,
        Err(e) => return format!("error:invalid AdminFactor hex: {}", e),
    };

    match recipient_path::build_composite_credential(user_cred.as_bytes(), &af) {
        Ok(composite) => hex::encode(composite),
        Err(e) => format!("error:{}", e),
    }
}

/// Compute a fingerprint (SHA-256 hash) of an AdminFactor.
/// Returns hex-encoded hash string.
#[wasm_bindgen]
pub fn custody_admin_factor_fingerprint(admin_factor_hex: &str) -> String {
    let af = match hex::decode(admin_factor_hex) {
        Ok(v) => v,
        Err(e) => return format!("error:invalid AdminFactor hex: {}", e),
    };
    recipient_path::admin_factor_fingerprint(&af)
}

// ─── Blob (AdminFactor + amount) for Authority distribution ───

/// Pack AdminFactor and amount into a blob (hex).
/// Blob = AdminFactor (32 bytes) || amount (8 bytes big-endian u64).
/// Returns blob hex, or "error:..." on failure.
#[wasm_bindgen]
pub fn custody_pack_admin_factor_with_amount(admin_factor_hex: &str, amount: u64) -> String {
    let af = match hex::decode(admin_factor_hex) {
        Ok(v) => v,
        Err(e) => return format!("error:invalid AdminFactor hex: {}", e),
    };
    match blob_amount::pack_admin_factor_with_amount(&af, amount) {
        Ok(blob) => hex::encode(blob),
        Err(e) => format!("error:{}", e),
    }
}

/// Parse blob (hex) into AdminFactor hex and amount.
/// Returns JSON string: { "admin_factor_hex": "...", "amount": 123 } or "error:...".
#[wasm_bindgen]
pub fn custody_parse_admin_factor_with_amount(blob_hex: &str) -> String {
    let blob = match hex::decode(blob_hex) {
        Ok(v) => v,
        Err(e) => return format!("error:invalid blob hex: {}", e),
    };
    match blob_amount::parse_admin_factor_with_amount(&blob) {
        Ok((af, amount)) => {
            let obj = serde_json::json!({
                "admin_factor_hex": hex::encode(af),
                "amount": amount,
            });
            serde_json::to_string(&obj).unwrap_or_else(|_| "error:serialize".to_string())
        }
        Err(e) => format!("error:{}", e),
    }
}

/// Build composite credential with amount: UserCred || AdminFactor || amount_8_bytes_be.
/// Returns hex-encoded composite (input to ACE-GF Argon2id). Or "error:...".
#[wasm_bindgen]
pub fn custody_build_composite_credential_with_amount(
    user_cred: &str,
    admin_factor_hex: &str,
    amount: u64,
) -> String {
    let af = match hex::decode(admin_factor_hex) {
        Ok(v) => v,
        Err(e) => return format!("error:invalid AdminFactor hex: {}", e),
    };
    match recipient_path::build_composite_credential_with_amount(user_cred.as_bytes(), &af, amount) {
        Ok(composite) => hex::encode(composite),
        Err(e) => format!("error:{}", e),
    }
}
