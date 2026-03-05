/**
 * Default WASM mock for tests that don't provide their own.
 */
module.exports = {
  custody_generate_admin_factor: () => ({
    admin_factor_hex: 'a'.repeat(64),
  }),
  custody_generate_path: (index, label) => ({
    user_cred: 'word1 word2 word3 word4 word5 word6',
    admin_factor_hex: 'a'.repeat(64),
    context: `recipient-${index}`,
    label,
  }),
  custody_derive_backup_key: () => 'b'.repeat(64),
  custody_encrypt_backup: () => 'c'.repeat(64),
  custody_decrypt_backup: () => 'a'.repeat(64),
  custody_admin_factor_fingerprint: () => 'd'.repeat(64),
  custody_encrypt_for_authority: () => ({
    package_hex: 'f'.repeat(128),
    ephemeral_pubkey_hex: 'g'.repeat(64),
  }),
  custody_build_composite: () => 'h'.repeat(64),
};
