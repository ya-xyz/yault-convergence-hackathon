//! Integration tests for AdminFactor management + E2E crypto

use yault_custody_wasm::custody::admin_factor::*;
use yault_custody_wasm::custody::e2e_crypto;
use yault_custody_wasm::custody::shamir;

fn test_rev() -> [u8; 16] {
    [0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04,
     0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C]
}

#[test]
fn test_full_lifecycle() {
    // 1. Generate AdminFactor
    let af = generate_admin_factor();
    assert_eq!(af.len(), 32);

    // 2. Derive backup key from REV
    let rev = test_rev();
    let ctx = ContextTuple::for_recipient(1);
    let backup_key = derive_backup_key(&rev, &ctx).unwrap();

    // 3. Encrypt for Arweave backup
    let encrypted = encrypt_admin_factor_backup(&af, backup_key.as_ref()).unwrap();

    // 4. Decrypt from backup
    let decrypted = decrypt_admin_factor_backup(&encrypted, backup_key.as_ref()).unwrap();
    assert_eq!(decrypted, af.to_vec());
}

#[test]
fn test_shamir_split_then_e2e_encrypt() {
    // Simulate: split AdminFactor into 3 shares, encrypt each for an authority

    let af = generate_admin_factor();
    let shares = shamir::split(&af, 3, 2).unwrap();
    assert_eq!(shares.len(), 3);

    // Each authority has a keypair
    let (pk_a, sk_a) = e2e_crypto::generate_x25519_keypair();
    let (pk_b, sk_b) = e2e_crypto::generate_x25519_keypair();
    let (pk_c, sk_c) = e2e_crypto::generate_x25519_keypair();

    let pubkeys = [pk_a, pk_b, pk_c];
    let seckeys = [sk_a, sk_b, sk_c];

    // Encrypt each share for its authority
    let mut encrypted_packages = Vec::new();
    for (share, pk) in shares.iter().zip(pubkeys.iter()) {
        let package = e2e_crypto::encrypt_for_authority(&share.data, pk).unwrap();
        encrypted_packages.push(package.to_bytes());
    }

    // Each authority decrypts their share
    let mut recovered_shares = Vec::new();
    for (i, (pkg_bytes, sk)) in encrypted_packages.iter().zip(seckeys.iter()).enumerate() {
        let decrypted = e2e_crypto::decrypt_from_user(pkg_bytes, sk).unwrap();
        recovered_shares.push(shamir::ShamirShare {
            index: shares[i].index,
            data: decrypted,
        });
    }

    // Any 2 authorities can reconstruct the AdminFactor
    let subset = vec![recovered_shares[0].clone(), recovered_shares[2].clone()];
    let reconstructed = shamir::reconstruct(&subset).unwrap();
    assert_eq!(reconstructed, af.to_vec());
}

#[test]
fn test_different_rev_different_backup_key() {
    let rev1 = [0x01; 16];
    let rev2 = [0x02; 16];
    let ctx = ContextTuple::for_recipient(1);

    let key1 = derive_backup_key(&rev1, &ctx).unwrap();
    let key2 = derive_backup_key(&rev2, &ctx).unwrap();
    assert_ne!(key1, key2);
}

#[test]
fn test_context_tuple_serialization() {
    let ctx = ContextTuple::for_recipient(42);
    let info = ctx.to_info_bytes();
    let info_str = String::from_utf8(info).unwrap();
    assert!(info_str.contains("42"));
    assert!(info_str.contains("AssetControl"));
    assert!(info_str.contains("AES-256-GCM-SIV"));
}

#[test]
fn test_backup_tamper_detection() {
    let rev = test_rev();
    let ctx = ContextTuple::for_recipient(1);
    let backup_key = derive_backup_key(&rev, &ctx).unwrap();

    let af = generate_admin_factor();
    let mut encrypted = encrypt_admin_factor_backup(&af, backup_key.as_ref()).unwrap();

    // Tamper with ciphertext
    let last = encrypted.len() - 1;
    encrypted[last] ^= 0xFF;

    // Should fail authentication
    assert!(decrypt_admin_factor_backup(&encrypted, backup_key.as_ref()).is_err());
}
