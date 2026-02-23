//! AdminFactor Management
//!
//! Generation, backup key derivation, and backup encrypt/decrypt.
//!
//! The AdminFactor is a 256-bit random value held by authority nodes.
//! It is one of the three components needed to activate a recipient path:
//!   Path Activation = SA_j + UserCred_j + AdminFactor_j
//!
//! Backup: The AdminFactor is backed up on Arweave, encrypted with a key
//! derived from REV (which only the wallet owner can reconstruct).
//!   backup_key = HKDF-SHA256(ikm=REV, salt="YALLET-ADMIN-FACTOR-BACKUP", info=context)
//!   ciphertext = AES-256-GCM-SIV(backup_key, AdminFactor)

use aes_gcm_siv::{
    aead::{Aead, KeyInit},
    Aes256GcmSiv, Nonce,
};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use serde::{Deserialize, Serialize};
use thiserror::Error;
// zeroize is available for future secure memory wiping

/// HKDF salt for AdminFactor backup key derivation
const BACKUP_SALT: &[u8] = b"YALLET-ADMIN-FACTOR-BACKUP";

/// AES-GCM-SIV nonce size (12 bytes)
const NONCE_SIZE: usize = 12;

/// AdminFactor size (32 bytes = 256 bits)
pub const ADMIN_FACTOR_SIZE: usize = 32;

#[derive(Error, Debug)]
pub enum AdminFactorError {
    #[error("invalid REV length: expected 16 bytes (UUID), got {0}")]
    InvalidRevLength(usize),
    #[error("invalid AdminFactor length: expected {ADMIN_FACTOR_SIZE}, got {0}")]
    InvalidAdminFactorLength(usize),
    #[error("invalid backup key length: expected 32, got {0}")]
    InvalidBackupKeyLength(usize),
    #[error("HKDF derivation failed")]
    HkdfError,
    #[error("encryption failed")]
    EncryptionError,
    #[error("decryption failed: wrong key or corrupted backup")]
    DecryptionError,
    #[error("backup ciphertext too short")]
    CiphertextTooShort,
}

/// Context tuple for HKDF derivation, matching ACE-GF's context isolation pattern.
/// Ctx = (AlgID, Domain, EntityID, Index)
///
/// - `alg_id`    — fixed algorithm identifier (e.g., "AES-256-GCM-SIV")
/// - `domain`    — isolation domain (e.g., "AssetControl", "OperatingFund", "Escrow")
/// - `entity_id` — owning entity (e.g., "personal", "corp-abc-123", DAO address)
/// - `index`     — sub-index within the entity/domain (e.g., vault #, path #)
///
/// HKDF info format:
/// - Personal (backward compat): "YALLET-V1-{alg}-{domain}-{index}"
/// - Institutional:               "YALLET-V1-{alg}-{domain}-{entity}-{index}"
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextTuple {
    pub alg_id: String,     // e.g., "AES-256-GCM-SIV"
    pub domain: String,     // e.g., "AssetControl", "OperatingFund", "Escrow"
    pub entity_id: String,  // e.g., "personal", "corp-abc-123"
    pub index: u32,         // sub-index within entity/domain
}

impl ContextTuple {
    /// Create a context tuple for a personal recipient path.
    /// Backward compatible — entity_id="personal" produces the same info
    /// bytes as the original 3-field format.
    pub fn for_recipient(index: u32) -> Self {
        Self {
            alg_id: "AES-256-GCM-SIV".to_string(),
            domain: "AssetControl".to_string(),
            entity_id: "personal".to_string(),
            index,
        }
    }

    /// Create a context tuple for an institutional vault.
    ///
    /// # Arguments
    /// * `entity_id` - Organization identifier (e.g., "corp-abc-123")
    /// * `domain`    - Vault purpose (e.g., "OperatingFund", "MnAEscrow", "EmployeeTrust")
    /// * `index`     - Vault index within this entity/domain
    pub fn for_institutional(entity_id: &str, domain: &str, index: u32) -> Self {
        Self {
            alg_id: "AES-256-GCM-SIV".to_string(),
            domain: domain.to_string(),
            entity_id: entity_id.to_string(),
            index,
        }
    }

    /// Serialize to bytes for HKDF info parameter (AdminFactor backup encryption).
    ///
    /// Backward compatibility: entity_id="personal" uses the original 3-field format
    /// so existing encrypted data can still be decrypted.
    pub fn to_info_bytes(&self) -> Vec<u8> {
        if self.entity_id == "personal" {
            format!("YALLET-V1-{}-{}-{}", self.alg_id, self.domain, self.index).into_bytes()
        } else {
            format!("YALLET-V1-{}-{}-{}-{}", self.alg_id, self.domain, self.entity_id, self.index).into_bytes()
        }
    }

    /// Convert to ACE-GF core context string for wallet key derivation.
    pub fn to_acegf_context(&self) -> String {
        if self.entity_id == "personal" {
            String::new()
        } else {
            format!("{}:{}:{}", self.entity_id, self.domain, self.index)
        }
    }
}

/// Generate a new random AdminFactor (256-bit).
pub fn generate_admin_factor() -> [u8; ADMIN_FACTOR_SIZE] {
    let mut af = [0u8; ADMIN_FACTOR_SIZE];
    rand::thread_rng().fill_bytes(&mut af);
    af
}

/// Derive a backup encryption key from REV using HKDF-SHA256.
pub fn derive_backup_key(
    rev: &[u8],
    ctx: &ContextTuple,
) -> Result<zeroize::Zeroizing<[u8; 32]>, AdminFactorError> {
    if rev.len() != 16 {
        return Err(AdminFactorError::InvalidRevLength(rev.len()));
    }

    let hkdf = Hkdf::<Sha256>::new(Some(BACKUP_SALT), rev);
    let info = ctx.to_info_bytes();
    let mut key = [0u8; 32];
    hkdf.expand(&info, &mut key)
        .map_err(|_| AdminFactorError::HkdfError)?;
    Ok(zeroize::Zeroizing::new(key))
}

/// Encrypt an AdminFactor for backup on Arweave.
pub fn encrypt_admin_factor_backup(
    admin_factor: &[u8],
    backup_key: &[u8],
) -> Result<Vec<u8>, AdminFactorError> {
    if admin_factor.len() != ADMIN_FACTOR_SIZE {
        return Err(AdminFactorError::InvalidAdminFactorLength(admin_factor.len()));
    }
    if backup_key.len() != 32 {
        return Err(AdminFactorError::InvalidBackupKeyLength(backup_key.len()));
    }

    let cipher = Aes256GcmSiv::new_from_slice(backup_key)
        .map_err(|_| AdminFactorError::EncryptionError)?;

    let mut nonce_bytes = [0u8; NONCE_SIZE];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, admin_factor)
        .map_err(|_| AdminFactorError::EncryptionError)?;

    let mut output = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

/// Decrypt an AdminFactor from an Arweave backup.
pub fn decrypt_admin_factor_backup(
    encrypted: &[u8],
    backup_key: &[u8],
) -> Result<Vec<u8>, AdminFactorError> {
    if backup_key.len() != 32 {
        return Err(AdminFactorError::InvalidBackupKeyLength(backup_key.len()));
    }
    if encrypted.len() < NONCE_SIZE + 16 {
        return Err(AdminFactorError::CiphertextTooShort);
    }

    let nonce = Nonce::from_slice(&encrypted[..NONCE_SIZE]);
    let ciphertext = &encrypted[NONCE_SIZE..];

    let cipher = Aes256GcmSiv::new_from_slice(backup_key)
        .map_err(|_| AdminFactorError::DecryptionError)?;

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| AdminFactorError::DecryptionError)?;

    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock_rev() -> [u8; 16] {
        [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
         0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10]
    }

    #[test]
    fn test_generate_admin_factor_is_random() {
        let af1 = generate_admin_factor();
        let af2 = generate_admin_factor();
        assert_ne!(af1, af2);
        assert_eq!(af1.len(), 32);
    }

    #[test]
    fn test_derive_backup_key_deterministic() {
        let rev = mock_rev();
        let ctx = ContextTuple::for_recipient(1);
        let key1 = derive_backup_key(&rev, &ctx).unwrap();
        let key2 = derive_backup_key(&rev, &ctx).unwrap();
        assert_eq!(*key1, *key2);
    }

    #[test]
    fn test_derive_backup_key_context_isolation() {
        let rev = mock_rev();
        let ctx1 = ContextTuple::for_recipient(1);
        let ctx2 = ContextTuple::for_recipient(2);
        let key1 = derive_backup_key(&rev, &ctx1).unwrap();
        let key2 = derive_backup_key(&rev, &ctx2).unwrap();
        assert_ne!(*key1, *key2, "different recipient indices must produce different keys");
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let rev = mock_rev();
        let ctx = ContextTuple::for_recipient(0);
        let backup_key = derive_backup_key(&rev, &ctx).unwrap();
        let admin_factor = generate_admin_factor();
        let encrypted = encrypt_admin_factor_backup(&admin_factor, backup_key.as_ref()).unwrap();
        let decrypted = decrypt_admin_factor_backup(&encrypted, backup_key.as_ref()).unwrap();
        assert_eq!(decrypted, admin_factor.to_vec());
    }

    #[test]
    fn test_decrypt_wrong_key_fails() {
        let rev = mock_rev();
        let ctx1 = ContextTuple::for_recipient(0);
        let ctx2 = ContextTuple::for_recipient(1);
        let key1 = derive_backup_key(&rev, &ctx1).unwrap();
        let key2 = derive_backup_key(&rev, &ctx2).unwrap();
        let admin_factor = generate_admin_factor();
        let encrypted = encrypt_admin_factor_backup(&admin_factor, key1.as_ref()).unwrap();
        assert!(decrypt_admin_factor_backup(&encrypted, key2.as_ref()).is_err());
    }

    #[test]
    fn test_invalid_rev_length() {
        let short_rev = [0u8; 8];
        let ctx = ContextTuple::for_recipient(0);
        assert!(derive_backup_key(&short_rev, &ctx).is_err());
    }

    #[test]
    fn test_ciphertext_not_empty() {
        let rev = mock_rev();
        let ctx = ContextTuple::for_recipient(0);
        let backup_key = derive_backup_key(&rev, &ctx).unwrap();
        let af = generate_admin_factor();
        let encrypted = encrypt_admin_factor_backup(&af, backup_key.as_ref()).unwrap();
        assert_eq!(encrypted.len(), 12 + 32 + 16);
    }

    #[test]
    fn test_personal_backward_compat() {
        let ctx = ContextTuple::for_recipient(1);
        let info = ctx.to_info_bytes();
        assert_eq!(
            String::from_utf8(info).unwrap(),
            "YALLET-V1-AES-256-GCM-SIV-AssetControl-1"
        );
    }

    #[test]
    fn test_institutional_context_format() {
        let ctx = ContextTuple::for_institutional("corp-abc", "OperatingFund", 0);
        let info = ctx.to_info_bytes();
        assert_eq!(
            String::from_utf8(info).unwrap(),
            "YALLET-V1-AES-256-GCM-SIV-OperatingFund-corp-abc-0"
        );
    }

    #[test]
    fn test_institutional_different_domains_isolated() {
        let rev = mock_rev();
        let ctx_ops = ContextTuple::for_institutional("corp-abc", "OperatingFund", 0);
        let ctx_escrow = ContextTuple::for_institutional("corp-abc", "MnAEscrow", 0);
        let key1 = derive_backup_key(&rev, &ctx_ops).unwrap();
        let key2 = derive_backup_key(&rev, &ctx_escrow).unwrap();
        assert_ne!(*key1, *key2, "different domains must produce different keys");
    }

    #[test]
    fn test_institutional_different_entities_isolated() {
        let rev = mock_rev();
        let ctx_a = ContextTuple::for_institutional("corp-abc", "OperatingFund", 0);
        let ctx_b = ContextTuple::for_institutional("corp-xyz", "OperatingFund", 0);
        let key1 = derive_backup_key(&rev, &ctx_a).unwrap();
        let key2 = derive_backup_key(&rev, &ctx_b).unwrap();
        assert_ne!(*key1, *key2, "different entities must produce different keys");
    }

    #[test]
    fn test_institutional_different_indices_isolated() {
        let rev = mock_rev();
        let ctx0 = ContextTuple::for_institutional("corp-abc", "OperatingFund", 0);
        let ctx1 = ContextTuple::for_institutional("corp-abc", "OperatingFund", 1);
        let key0 = derive_backup_key(&rev, &ctx0).unwrap();
        let key1 = derive_backup_key(&rev, &ctx1).unwrap();
        assert_ne!(*key0, *key1, "different indices must produce different keys");
    }

    #[test]
    fn test_institutional_vs_personal_isolated() {
        let rev = mock_rev();
        let personal = ContextTuple::for_recipient(0);
        let inst = ContextTuple::for_institutional("corp-abc", "AssetControl", 0);
        let key_p = derive_backup_key(&rev, &personal).unwrap();
        let key_i = derive_backup_key(&rev, &inst).unwrap();
        assert_ne!(*key_p, *key_i, "personal and institutional must be isolated even with same domain+index");
    }

    #[test]
    fn test_institutional_encrypt_decrypt_roundtrip() {
        let rev = mock_rev();
        let ctx = ContextTuple::for_institutional("corp-abc", "MnAEscrow", 2);
        let backup_key = derive_backup_key(&rev, &ctx).unwrap();
        let af = generate_admin_factor();
        let encrypted = encrypt_admin_factor_backup(&af, backup_key.as_ref()).unwrap();
        let decrypted = decrypt_admin_factor_backup(&encrypted, backup_key.as_ref()).unwrap();
        assert_eq!(decrypted, af.to_vec());
    }

    #[test]
    fn test_acegf_context_personal_is_empty() {
        let ctx = ContextTuple::for_recipient(0);
        assert_eq!(ctx.to_acegf_context(), "");
    }

    #[test]
    fn test_acegf_context_personal_any_index_is_empty() {
        for i in 0..5 {
            let ctx = ContextTuple::for_recipient(i);
            assert_eq!(ctx.to_acegf_context(), "", "personal index {} should be empty", i);
        }
    }

    #[test]
    fn test_acegf_context_institutional_format() {
        let ctx = ContextTuple::for_institutional("corp-abc", "OperatingFund", 0);
        assert_eq!(ctx.to_acegf_context(), "corp-abc:OperatingFund:0");
    }

    #[test]
    fn test_acegf_context_institutional_different_vaults() {
        let ctx1 = ContextTuple::for_institutional("corp-abc", "OperatingFund", 0);
        let ctx2 = ContextTuple::for_institutional("corp-abc", "MnAEscrow", 0);
        let ctx3 = ContextTuple::for_institutional("corp-abc", "OperatingFund", 1);
        let ctx4 = ContextTuple::for_institutional("corp-xyz", "OperatingFund", 0);
        let s1 = ctx1.to_acegf_context();
        let s2 = ctx2.to_acegf_context();
        let s3 = ctx3.to_acegf_context();
        let s4 = ctx4.to_acegf_context();
        assert_ne!(s1, s2, "different domain");
        assert_ne!(s1, s3, "different index");
        assert_ne!(s1, s4, "different entity");
        assert_ne!(s2, s3, "domain vs index");
    }

    #[test]
    fn test_institutional_cross_context_decrypt_fails() {
        let rev = mock_rev();
        let ctx_ops = ContextTuple::for_institutional("corp-abc", "OperatingFund", 0);
        let ctx_escrow = ContextTuple::for_institutional("corp-abc", "MnAEscrow", 0);
        let key_ops = derive_backup_key(&rev, &ctx_ops).unwrap();
        let key_escrow = derive_backup_key(&rev, &ctx_escrow).unwrap();
        let af = generate_admin_factor();
        let encrypted = encrypt_admin_factor_backup(&af, key_ops.as_ref()).unwrap();
        assert!(decrypt_admin_factor_backup(&encrypted, key_escrow.as_ref()).is_err());
    }
}
