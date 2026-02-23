//! Shamir Secret Sharing over GF(256)
//!
//! Split a secret into N shares with threshold T.
//! Any T shares can reconstruct the original; fewer reveal nothing.
//!
//! Used for: multi-authority AdminFactor redundancy (default: 2-of-3)

use rand::RngCore;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ShamirError {
    #[error("threshold must be >= 2")]
    ThresholdTooLow,
    #[error("threshold ({0}) must be <= total ({1})")]
    ThresholdExceedsTotal(u8, u8),
    #[error("total shares must be <= 255")]
    TotalTooHigh,
    #[error("not enough shares: need {needed}, got {got}")]
    NotEnoughShares { needed: u8, got: usize },
    #[error("share index must be non-zero (1..=255)")]
    ZeroIndex,
    #[error("duplicate share index {0}")]
    DuplicateIndex(u8),
    #[error("inconsistent share lengths")]
    InconsistentLengths,
    #[error("empty secret")]
    EmptySecret,
}

/// A single Shamir share: (index, data).
/// index is 1-based (1..=255), data is same length as the original secret.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShamirShare {
    /// 1-based share index (the x-coordinate in GF(256))
    pub index: u8,
    /// Share data (same length as original secret)
    pub data: Vec<u8>,
}

// ─── GF(256) arithmetic ───
// Irreducible polynomial: x^8 + x^4 + x^3 + x + 1 = 0x11B (AES field)

/// GF(256) multiplication using Russian-peasant algorithm
fn gf256_mul(mut a: u8, mut b: u8) -> u8 {
    let mut result: u8 = 0;
    while b > 0 {
        if b & 1 != 0 {
            result ^= a;
        }
        let carry = a & 0x80;
        a <<= 1;
        if carry != 0 {
            a ^= 0x1B; // reduce by x^8 + x^4 + x^3 + x + 1
        }
        b >>= 1;
    }
    result
}

/// GF(256) multiplicative inverse via extended Euclidean or Fermat's little theorem.
/// a^(-1) = a^(254) in GF(256) since |GF(256)*| = 255.
fn gf256_inv(a: u8) -> u8 {
    if a == 0 {
        return 0; // 0 has no inverse; caller must avoid
    }
    // a^254 = a^(128+64+32+16+8+4+2) via repeated squaring
    let mut result = a;
    for _ in 0..6 {
        result = gf256_mul(result, result); // square
        result = gf256_mul(result, a);       // multiply by a
    }
    // one more square to get a^254
    result = gf256_mul(result, result);
    result
}

/// Evaluate a polynomial at x in GF(256) using Horner's method.
/// coefficients[0] is the constant term (the secret byte), coefficients[1..] are random.
fn gf256_poly_eval(coefficients: &[u8], x: u8) -> u8 {
    let mut result: u8 = 0;
    for coeff in coefficients.iter().rev() {
        result = gf256_mul(result, x) ^ coeff;
    }
    result
}

/// Split a secret into `total` shares with reconstruction threshold `threshold`.
///
/// # Arguments
/// * `secret` - The secret bytes to split (e.g., 32-byte AdminFactor)
/// * `total` - Total number of shares to generate (e.g., 3)
/// * `threshold` - Minimum shares needed to reconstruct (e.g., 2)
///
/// # Returns
/// A vector of `total` shares, each with a unique 1-based index.
pub fn split(secret: &[u8], total: u8, threshold: u8) -> Result<Vec<ShamirShare>, ShamirError> {
    if secret.is_empty() {
        return Err(ShamirError::EmptySecret);
    }
    if threshold < 2 {
        return Err(ShamirError::ThresholdTooLow);
    }
    if threshold > total {
        return Err(ShamirError::ThresholdExceedsTotal(threshold, total));
    }
    // Note: total is u8 so max is 255 — type system enforces the GF(256) limit

    let secret_len = secret.len();
    let mut rng = rand::thread_rng();

    // Initialize shares
    let mut shares: Vec<ShamirShare> = (1..=total)
        .map(|i| ShamirShare {
            index: i,
            data: vec![0u8; secret_len],
        })
        .collect();

    // For each byte of the secret, generate a random polynomial and evaluate
    let coeff_count = threshold as usize; // degree = threshold - 1
    let mut coefficients = vec![0u8; coeff_count];

    for byte_idx in 0..secret_len {
        // coefficients[0] = secret byte (constant term)
        coefficients[0] = secret[byte_idx];

        // coefficients[1..] = random bytes
        let mut random_bytes = vec![0u8; coeff_count - 1];
        rng.fill_bytes(&mut random_bytes);
        coefficients[1..].copy_from_slice(&random_bytes);

        // Evaluate polynomial at x = share.index for each share
        for share in shares.iter_mut() {
            share.data[byte_idx] = gf256_poly_eval(&coefficients, share.index);
        }
    }

    // C-08 FIX: Use zeroize crate for compiler-safe memory clearing
    use zeroize::Zeroize;
    coefficients.zeroize();

    Ok(shares)
}

/// Reconstruct the original secret from `threshold` or more shares
/// using Lagrange interpolation over GF(256).
///
/// # Arguments
/// * `shares` - At least `threshold` shares (the threshold is implicit from the original split)
///
/// # Returns
/// The reconstructed secret bytes.
pub fn reconstruct(shares: &[ShamirShare]) -> Result<Vec<u8>, ShamirError> {
    if shares.is_empty() {
        return Err(ShamirError::NotEnoughShares { needed: 2, got: 0 });
    }

    // Validate: all shares must have same length
    let secret_len = shares[0].data.len();
    for s in shares.iter() {
        if s.data.len() != secret_len {
            return Err(ShamirError::InconsistentLengths);
        }
        if s.index == 0 {
            return Err(ShamirError::ZeroIndex);
        }
    }

    // Check for duplicate indices
    let mut seen = [false; 256];
    for s in shares.iter() {
        if seen[s.index as usize] {
            return Err(ShamirError::DuplicateIndex(s.index));
        }
        seen[s.index as usize] = true;
    }

    let n = shares.len();
    let mut secret = vec![0u8; secret_len];

    // Lagrange interpolation at x=0
    for byte_idx in 0..secret_len {
        let mut value: u8 = 0;

        for i in 0..n {
            let xi = shares[i].index;
            let yi = shares[i].data[byte_idx];

            // Compute Lagrange basis polynomial L_i(0)
            // L_i(0) = product_{j!=i} (0 - x_j) / (x_i - x_j)
            //        = product_{j!=i} x_j / (x_i ^ x_j)   [in GF(256), subtraction = XOR]
            let mut numerator: u8 = 1;
            let mut denominator: u8 = 1;

            for j in 0..n {
                if i == j {
                    continue;
                }
                let xj = shares[j].index;
                numerator = gf256_mul(numerator, xj);        // * x_j (since we evaluate at 0)
                denominator = gf256_mul(denominator, xi ^ xj); // * (x_i - x_j) = x_i XOR x_j
            }

            // #2 FIX: Assert denominator is non-zero before computing inverse
            assert!(denominator != 0, "Lagrange denominator is zero — duplicate or zero-index shares");

            // L_i(0) = numerator * denominator^(-1)
            let lagrange = gf256_mul(numerator, gf256_inv(denominator));

            // Accumulate: secret_byte ^= y_i * L_i(0)
            value ^= gf256_mul(yi, lagrange);
        }

        secret[byte_idx] = value;
    }

    Ok(secret)
}

/// #15 FIX: Reconstruct with explicit threshold enforcement.
///
/// Validates that the number of shares meets the required threshold before
/// attempting reconstruction. This prevents silent garbage output when
/// fewer-than-threshold shares are provided.
///
/// # Arguments
/// * `shares` - The shares to reconstruct from
/// * `threshold` - Minimum number of shares required (must match the original split threshold)
///
/// # Returns
/// The reconstructed secret bytes, or an error if insufficient shares.
pub fn reconstruct_with_threshold(shares: &[ShamirShare], threshold: u8) -> Result<Vec<u8>, ShamirError> {
    if (shares.len() as u8) < threshold {
        return Err(ShamirError::NotEnoughShares {
            needed: threshold,
            got: shares.len(),
        });
    }
    reconstruct(shares)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gf256_mul_identity() {
        assert_eq!(gf256_mul(1, 0x53), 0x53);
        assert_eq!(gf256_mul(0x53, 1), 0x53);
    }

    #[test]
    fn test_gf256_mul_zero() {
        assert_eq!(gf256_mul(0, 0x53), 0);
        assert_eq!(gf256_mul(0x53, 0), 0);
    }

    #[test]
    fn test_gf256_inverse() {
        for a in 1u16..=255 {
            let inv = gf256_inv(a as u8);
            assert_eq!(gf256_mul(a as u8, inv), 1, "inverse failed for {}", a);
        }
    }

    #[test]
    fn test_split_reconstruct_2_of_3() {
        let secret = b"this is a 32-byte admin factor!X";
        let shares = split(secret, 3, 2).unwrap();
        assert_eq!(shares.len(), 3);

        // Any 2 of 3 should reconstruct
        for i in 0..3 {
            for j in (i + 1)..3 {
                let subset = vec![shares[i].clone(), shares[j].clone()];
                let recovered = reconstruct(&subset).unwrap();
                assert_eq!(recovered, secret.to_vec(), "failed with shares ({}, {})", i, j);
            }
        }
    }

    #[test]
    fn test_split_reconstruct_3_of_5() {
        let secret = vec![0xAB; 32]; // 32-byte secret
        let shares = split(&secret, 5, 3).unwrap();
        assert_eq!(shares.len(), 5);

        // Any 3 of 5 should reconstruct
        let subset = vec![shares[0].clone(), shares[2].clone(), shares[4].clone()];
        let recovered = reconstruct(&subset).unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn test_single_byte_secret() {
        let secret = vec![0x42];
        let shares = split(&secret, 3, 2).unwrap();
        let subset = vec![shares[0].clone(), shares[2].clone()];
        let recovered = reconstruct(&subset).unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn test_large_secret() {
        let secret: Vec<u8> = (0..=255).collect(); // 256 bytes
        let shares = split(&secret, 3, 2).unwrap();
        let subset = vec![shares[1].clone(), shares[2].clone()];
        let recovered = reconstruct(&subset).unwrap();
        assert_eq!(recovered, secret);
    }

    #[test]
    fn test_threshold_too_low() {
        let secret = vec![0x01];
        assert!(split(&secret, 3, 1).is_err());
    }

    #[test]
    fn test_threshold_exceeds_total() {
        let secret = vec![0x01];
        assert!(split(&secret, 2, 3).is_err());
    }

    #[test]
    fn test_empty_secret() {
        assert!(split(&[], 3, 2).is_err());
    }

    #[test]
    fn test_duplicate_index_rejected() {
        let secret = vec![0x42];
        let shares = split(&secret, 3, 2).unwrap();
        let dup = vec![shares[0].clone(), shares[0].clone()];
        assert!(reconstruct(&dup).is_err());
    }

    #[test]
    fn test_reconstruct_with_threshold_enforced() {
        let secret = b"threshold enforcement test!!!!!XX";
        let shares = split(secret, 5, 3).unwrap();

        // Exactly threshold shares should work
        let subset_3 = vec![shares[0].clone(), shares[2].clone(), shares[4].clone()];
        let recovered = reconstruct_with_threshold(&subset_3, 3).unwrap();
        assert_eq!(recovered, secret.to_vec());

        // Below threshold should fail
        let subset_2 = vec![shares[0].clone(), shares[2].clone()];
        let result = reconstruct_with_threshold(&subset_2, 3);
        assert!(result.is_err());
        match result.unwrap_err() {
            ShamirError::NotEnoughShares { needed, got } => {
                assert_eq!(needed, 3);
                assert_eq!(got, 2);
            }
            other => panic!("Expected NotEnoughShares, got {:?}", other),
        }
    }

    #[test]
    fn test_all_3_shares_also_works() {
        let secret = vec![0xDE, 0xAD, 0xBE, 0xEF];
        let shares = split(&secret, 3, 2).unwrap();
        // Using all 3 shares (more than threshold) should still work
        let recovered = reconstruct(&shares).unwrap();
        assert_eq!(recovered, secret);
    }
}
