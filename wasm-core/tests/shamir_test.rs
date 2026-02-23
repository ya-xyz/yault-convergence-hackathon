//! Integration tests for Shamir Secret Sharing
//!
//! Tests the full split → reconstruct cycle with various configurations.

use yault_custody_wasm::custody::shamir::{split, reconstruct};

#[test]
fn test_2_of_3_all_combinations() {
    let secret: Vec<u8> = (0..32).collect();
    let shares = split(&secret, 3, 2).unwrap();

    // All C(3,2) = 3 combinations
    let combos = vec![(0, 1), (0, 2), (1, 2)];
    for (i, j) in combos {
        let subset = vec![shares[i].clone(), shares[j].clone()];
        let recovered = reconstruct(&subset).unwrap();
        assert_eq!(recovered, secret, "failed for combination ({}, {})", i, j);
    }
}

#[test]
fn test_3_of_5_various_subsets() {
    let secret = vec![0xFF; 64]; // 64-byte secret
    let shares = split(&secret, 5, 3).unwrap();

    // Several 3-element subsets
    let subsets: Vec<Vec<usize>> = vec![
        vec![0, 1, 2],
        vec![0, 2, 4],
        vec![1, 3, 4],
        vec![2, 3, 4],
    ];

    for subset_indices in subsets {
        let subset: Vec<_> = subset_indices.iter().map(|&i| shares[i].clone()).collect();
        let recovered = reconstruct(&subset).unwrap();
        assert_eq!(recovered, secret, "failed for subset {:?}", subset_indices);
    }
}

#[test]
fn test_shares_differ_from_secret() {
    let secret = vec![0x42; 32];
    let shares = split(&secret, 3, 2).unwrap();

    // Each share should be different from the secret
    for share in &shares {
        assert_ne!(share.data, secret, "share {} equals secret", share.index);
    }
}

#[test]
fn test_shares_differ_from_each_other() {
    let secret = vec![0x42; 32];
    let shares = split(&secret, 3, 2).unwrap();

    assert_ne!(shares[0].data, shares[1].data);
    assert_ne!(shares[0].data, shares[2].data);
    assert_ne!(shares[1].data, shares[2].data);
}

#[test]
fn test_4_of_7() {
    let secret: Vec<u8> = (0..48).collect();
    let shares = split(&secret, 7, 4).unwrap();
    assert_eq!(shares.len(), 7);

    let subset = vec![
        shares[1].clone(),
        shares[3].clone(),
        shares[5].clone(),
        shares[6].clone(),
    ];
    let recovered = reconstruct(&subset).unwrap();
    assert_eq!(recovered, secret);
}

#[test]
fn test_2_of_2_minimum_config() {
    let secret = vec![0xAB, 0xCD];
    let shares = split(&secret, 2, 2).unwrap();
    assert_eq!(shares.len(), 2);
    let recovered = reconstruct(&shares).unwrap();
    assert_eq!(recovered, secret);
}

#[test]
fn test_split_preserves_indices() {
    let secret = vec![0x01; 16];
    let shares = split(&secret, 5, 3).unwrap();
    for (i, share) in shares.iter().enumerate() {
        assert_eq!(share.index, (i + 1) as u8);
    }
}
