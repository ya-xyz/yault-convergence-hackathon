//! Yault Custody WASM Core
//!
//! Crypto primitives specific to the non-custodial asset release platform.
//! Builds on ACE-GF framework primitives (HKDF, AES-GCM-SIV, Argon2id).
//!
//! New primitives provided by this crate:
//! - Shamir Secret Sharing over GF(256) for AdminFactor redundancy
//! - E2E encryption (X25519 ECDH + ChaCha20-Poly1305) for authority transport
//! - AdminFactor backup key derivation (HKDF) + AES-GCM-SIV encrypt/decrypt
//! - Recipient path credential generation and composite credential building

pub mod custody;
