//! End-to-End Encryption: User → Authority
//!
//! X25519 ECDH key agreement + ChaCha20-Poly1305 authenticated encryption.
//! Used for securely transporting AdminFactor shares to authorities.
//!
//! Protocol:
//! 1. User generates ephemeral X25519 keypair
//! 2. User computes shared_secret = X25519(ephemeral_secret, authority_pubkey)
//! 3. Derive encryption key = HKDF-SHA256(shared_secret, salt="YALLET-E2E", info="v1")
//! 4. Encrypt message with ChaCha20-Poly1305(derived_key, random_nonce, message)
//! 5. Output: ephemeral_pubkey || nonce || ciphertext+tag

use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use thiserror::Error;
use x25519_dalek::{EphemeralSecret, PublicKey, StaticSecret};
use zeroize::Zeroize;

/// Nonce size for ChaCha20-Poly1305 (12 bytes)
const NONCE_SIZE: usize = 12;
/// X25519 public key size (32 bytes)
const PUBKEY_SIZE: usize = 32;
/// ChaCha20-Poly1305 authentication tag size (16 bytes)
const TAG_SIZE: usize = 16;
/// HKDF salt for E2E key derivation
const E2E_SALT: &[u8] = b"YALLET-E2E";
/// HKDF info for E2E key derivation
const E2E_INFO: &[u8] = b"YALLET-E2E-V1-CHACHA20POLY1305";

#[derive(Error, Debug)]
pub enum E2eError {
    #[error("invalid public key length: expected {PUBKEY_SIZE}, got {0}")]
    InvalidPubkeyLength(usize),
    #[error("invalid secret key length: expected 32, got {0}")]
    InvalidSecretKeyLength(usize),
    #[error("ciphertext too short: minimum {min} bytes, got {got}")]
    CiphertextTooShort { min: usize, got: usize },
    #[error("HKDF expansion failed")]
    HkdfError,
    #[error("encryption failed")]
    EncryptionError,
    #[error("decryption failed: invalid key or corrupted data")]
    DecryptionError,
}

/// Result of E2E encryption: contains everything the recipient needs to decrypt.
pub struct E2ePackage {
    /// Sender's ephemeral X25519 public key (32 bytes)
    pub ephemeral_pubkey: [u8; PUBKEY_SIZE],
    /// Encrypted payload: nonce (12) || ciphertext + tag
    pub ciphertext: Vec<u8>,
}

impl E2ePackage {
    /// Serialize to bytes: ephemeral_pubkey (32) || nonce (12) || ciphertext+tag
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(PUBKEY_SIZE + self.ciphertext.len());
        out.extend_from_slice(&self.ephemeral_pubkey);
        out.extend_from_slice(&self.ciphertext);
        out
    }

    /// Deserialize from bytes
    pub fn from_bytes(data: &[u8]) -> Result<Self, E2eError> {
        let min_len = PUBKEY_SIZE + NONCE_SIZE + TAG_SIZE; // 32 + 12 + 16 = 60
        if data.len() < min_len {
            return Err(E2eError::CiphertextTooShort {
                min: min_len,
                got: data.len(),
            });
        }
        let mut ephemeral_pubkey = [0u8; PUBKEY_SIZE];
        ephemeral_pubkey.copy_from_slice(&data[..PUBKEY_SIZE]);
        let ciphertext = data[PUBKEY_SIZE..].to_vec();
        Ok(Self {
            ephemeral_pubkey,
            ciphertext,
        })
    }
}

/// Derive a ChaCha20-Poly1305 key from a shared secret using HKDF-SHA256.
fn derive_encryption_key(shared_secret: &[u8]) -> Result<[u8; 32], E2eError> {
    let hkdf = Hkdf::<Sha256>::new(Some(E2E_SALT), shared_secret);
    let mut key = [0u8; 32];
    hkdf.expand(E2E_INFO, &mut key)
        .map_err(|_| E2eError::HkdfError)?;
    Ok(key)
}

/// Generate a new X25519 keypair for use as an authority's identity.
///
/// Returns (public_key_bytes, secret_key_bytes)
pub fn generate_x25519_keypair() -> ([u8; 32], [u8; 32]) {
    let mut rng = rand::thread_rng();
    let secret = StaticSecret::random_from_rng(&mut rng);
    let public = PublicKey::from(&secret);
    (public.to_bytes(), secret.to_bytes())
}

/// Encrypt a message for an authority using their X25519 public key.
///
/// Generates an ephemeral X25519 keypair, performs ECDH, derives an encryption key,
/// and encrypts the message with ChaCha20-Poly1305.
///
/// # Arguments
/// * `message` - The plaintext to encrypt (e.g., AdminFactor share)
/// * `authority_pubkey` - The authority's X25519 public key (32 bytes)
///
/// # Returns
/// An `E2ePackage` containing the ephemeral public key and ciphertext.
pub fn encrypt_for_authority(
    message: &[u8],
    authority_pubkey: &[u8],
) -> Result<E2ePackage, E2eError> {
    if authority_pubkey.len() != PUBKEY_SIZE {
        return Err(E2eError::InvalidPubkeyLength(authority_pubkey.len()));
    }

    let mut recipient_pk_bytes = [0u8; 32];
    recipient_pk_bytes.copy_from_slice(authority_pubkey);
    let recipient_pk = PublicKey::from(recipient_pk_bytes);

    // Generate ephemeral keypair
    let mut rng = rand::thread_rng();
    let ephemeral_secret = EphemeralSecret::random_from_rng(&mut rng);
    let ephemeral_public = PublicKey::from(&ephemeral_secret);

    // ECDH: shared_secret = X25519(ephemeral_secret, authority_pubkey)
    let shared_secret = ephemeral_secret.diffie_hellman(&recipient_pk);

    // Derive encryption key
    let mut enc_key = derive_encryption_key(shared_secret.as_bytes())?;

    // Generate random nonce
    let mut nonce_bytes = [0u8; NONCE_SIZE];
    rng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    // Encrypt
    let cipher = ChaCha20Poly1305::new_from_slice(&enc_key)
        .map_err(|_| E2eError::EncryptionError)?;
    let encrypted = cipher
        .encrypt(nonce, message)
        .map_err(|_| E2eError::EncryptionError)?;

    // Zeroize key
    enc_key.zeroize();

    // Build output: nonce || ciphertext+tag
    let mut ciphertext = Vec::with_capacity(NONCE_SIZE + encrypted.len());
    ciphertext.extend_from_slice(&nonce_bytes);
    ciphertext.extend_from_slice(&encrypted);

    Ok(E2ePackage {
        ephemeral_pubkey: ephemeral_public.to_bytes(),
        ciphertext,
    })
}

/// Decrypt a message from a user, given the sender's ephemeral public key.
///
/// # Arguments
/// * `package_bytes` - Serialized E2ePackage: ephemeral_pubkey (32) || nonce (12) || ciphertext+tag
/// * `authority_secret` - The authority's X25519 secret key (32 bytes)
///
/// # Returns
/// The decrypted plaintext.
pub fn decrypt_from_user(
    package_bytes: &[u8],
    authority_secret: &[u8],
) -> Result<Vec<u8>, E2eError> {
    if authority_secret.len() != 32 {
        return Err(E2eError::InvalidSecretKeyLength(authority_secret.len()));
    }

    let package = E2ePackage::from_bytes(package_bytes)?;

    // Reconstruct keys
    let sender_pk = PublicKey::from(package.ephemeral_pubkey);
    let mut sk_bytes = [0u8; 32];
    sk_bytes.copy_from_slice(authority_secret);
    let receiver_sk = StaticSecret::from(sk_bytes);

    // ECDH
    let shared_secret = receiver_sk.diffie_hellman(&sender_pk);

    // Derive decryption key
    let mut dec_key = derive_encryption_key(shared_secret.as_bytes())?;

    // Extract nonce and ciphertext
    if package.ciphertext.len() < NONCE_SIZE + TAG_SIZE {
        return Err(E2eError::CiphertextTooShort {
            min: NONCE_SIZE + TAG_SIZE,
            got: package.ciphertext.len(),
        });
    }
    let nonce = Nonce::from_slice(&package.ciphertext[..NONCE_SIZE]);
    let encrypted = &package.ciphertext[NONCE_SIZE..];

    // Decrypt
    let cipher = ChaCha20Poly1305::new_from_slice(&dec_key)
        .map_err(|_| E2eError::DecryptionError)?;
    let plaintext = cipher
        .decrypt(nonce, encrypted)
        .map_err(|_| E2eError::DecryptionError)?;

    // Zeroize
    dec_key.zeroize();
    sk_bytes.zeroize();

    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let (authority_pk, authority_sk) = generate_x25519_keypair();
        let message = b"this is a secret AdminFactor share";

        let package = encrypt_for_authority(message, &authority_pk).unwrap();
        let serialized = package.to_bytes();
        let decrypted = decrypt_from_user(&serialized, &authority_sk).unwrap();

        assert_eq!(decrypted, message.to_vec());
    }

    #[test]
    fn test_wrong_key_fails() {
        let (authority_pk, _authority_sk) = generate_x25519_keypair();
        let (_other_pk, other_sk) = generate_x25519_keypair();
        let message = b"secret data";

        let package = encrypt_for_authority(message, &authority_pk).unwrap();
        let serialized = package.to_bytes();

        // Decrypt with wrong key should fail
        let result = decrypt_from_user(&serialized, &other_sk);
        assert!(result.is_err());
    }

    #[test]
    fn test_empty_message() {
        let (pk, sk) = generate_x25519_keypair();
        let message = b"";

        let package = encrypt_for_authority(message, &pk).unwrap();
        let decrypted = decrypt_from_user(&package.to_bytes(), &sk).unwrap();
        assert_eq!(decrypted, message.to_vec());
    }

    #[test]
    fn test_large_message() {
        let (pk, sk) = generate_x25519_keypair();
        let message: Vec<u8> = (0..1024).map(|i| (i % 256) as u8).collect();

        let package = encrypt_for_authority(&message, &pk).unwrap();
        let decrypted = decrypt_from_user(&package.to_bytes(), &sk).unwrap();
        assert_eq!(decrypted, message);
    }

    #[test]
    fn test_invalid_pubkey_length() {
        let result = encrypt_for_authority(b"test", &[0u8; 16]);
        assert!(result.is_err());
    }

    #[test]
    fn test_corrupted_ciphertext() {
        let (pk, sk) = generate_x25519_keypair();
        let package = encrypt_for_authority(b"test", &pk).unwrap();
        let mut bytes = package.to_bytes();
        // Corrupt a ciphertext byte
        let last = bytes.len() - 1;
        bytes[last] ^= 0xFF;
        assert!(decrypt_from_user(&bytes, &sk).is_err());
    }
}
