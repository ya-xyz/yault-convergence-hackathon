//! AdminFactor blob with amount (for Authority distribution and claim-time parsing).
//!
//! Blob format: AdminFactor (32 bytes) || amount_u64 (8 bytes big-endian).
//! Used so that claim flow can derive amount from the released blob without user input;
//! composite credential binds UserCred || AdminFactor || amount for Unseal.

use super::admin_factor::ADMIN_FACTOR_SIZE;
use thiserror::Error;

/// Blob length: 32 (AdminFactor) + 8 (amount u64 BE)
pub const BLOB_LEN: usize = ADMIN_FACTOR_SIZE + 8;

#[derive(Error, Debug)]
pub enum BlobAmountError {
    #[error("invalid AdminFactor length: expected {ADMIN_FACTOR_SIZE}, got {0}")]
    InvalidAdminFactorLength(usize),
    #[error("invalid blob length: expected {BLOB_LEN}, got {0}")]
    InvalidBlobLength(usize),
    #[error("invalid hex: {0}")]
    InvalidHex(String),
}

/// Pack AdminFactor and amount into a single blob (hex).
/// Amount is encoded as 8-byte big-endian u64 (same magnitude as EVM uint64; for full uint256 use upper bytes zero).
pub fn pack_admin_factor_with_amount(admin_factor: &[u8], amount: u64) -> Result<Vec<u8>, BlobAmountError> {
    if admin_factor.len() != ADMIN_FACTOR_SIZE {
        return Err(BlobAmountError::InvalidAdminFactorLength(admin_factor.len()));
    }
    let mut blob = Vec::with_capacity(BLOB_LEN);
    blob.extend_from_slice(admin_factor);
    blob.extend_from_slice(&amount.to_be_bytes());
    Ok(blob)
}

/// Parse blob into AdminFactor and amount.
pub fn parse_admin_factor_with_amount(blob: &[u8]) -> Result<([u8; ADMIN_FACTOR_SIZE], u64), BlobAmountError> {
    if blob.len() != BLOB_LEN {
        return Err(BlobAmountError::InvalidBlobLength(blob.len()));
    }
    let mut af = [0u8; ADMIN_FACTOR_SIZE];
    af.copy_from_slice(&blob[..ADMIN_FACTOR_SIZE]);
    let amount = u64::from_be_bytes(blob[ADMIN_FACTOR_SIZE..BLOB_LEN].try_into().unwrap());
    Ok((af, amount))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pack_parse_roundtrip() {
        let af = [0xABu8; ADMIN_FACTOR_SIZE];
        let amount = 1_000_000_000u64; // 1000 * 1e6
        let blob = pack_admin_factor_with_amount(&af, amount).unwrap();
        assert_eq!(blob.len(), BLOB_LEN);
        let (af2, amount2) = parse_admin_factor_with_amount(&blob).unwrap();
        assert_eq!(af2, af);
        assert_eq!(amount2, amount);
    }

    #[test]
    fn test_parse_wrong_length_fails() {
        let short = vec![0u8; 32];
        assert!(parse_admin_factor_with_amount(&short).is_err());
        let long = vec![0u8; 50];
        assert!(parse_admin_factor_with_amount(&long).is_err());
    }

    #[test]
    fn test_pack_wrong_af_length_fails() {
        let short_af = [0u8; 16];
        assert!(pack_admin_factor_with_amount(&short_af, 100).is_err());
    }
}
