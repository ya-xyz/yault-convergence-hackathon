/* tslint:disable */
/* eslint-disable */

/**
 * Compute a fingerprint (SHA-256 hash) of an AdminFactor.
 * Returns hex-encoded hash string.
 */
export function custody_admin_factor_fingerprint(admin_factor_hex: string): string;

/**
 * Build the ACE-GF core context string for institutional vault key derivation.
 *
 * This produces the `context_info` parameter that should be passed to
 * acegf-core's `view_wallet_wasm_with_context()` function. ACE-GF core
 * appends this to each chain's HKDF info label (e.g., "ACEGF-REV32-V1-ED25519-SOLANA:context"),
 * producing cryptographically independent chain keys per vault.
 *
 * Returns:
 * - Personal (entity_id="personal"): "" (empty string → backward compatible)
 * - Institutional: "{entity_id}:{domain}:{index}"
 *
 * # Arguments
 * * `entity_id` - Organization identifier (e.g., "corp-abc-123", or "personal")
 * * `domain`    - Vault purpose (e.g., "OperatingFund", "MnAEscrow")
 * * `index`     - Vault index within this entity/domain
 */
export function custody_build_acegf_context(entity_id: string, domain: string, index: number): string;

/**
 * Build a composite credential from UserCred and AdminFactor.
 * Returns hex-encoded composite bytes (input to Argon2id), or "error:...".
 *
 * The composite is: UserCred_bytes || AdminFactor_bytes
 * Caller should pass this to acegf-core's Argon2id for the actual KDF.
 */
export function custody_build_composite(user_cred: string, admin_factor_hex: string): string;

/**
 * Build composite credential with amount: UserCred || AdminFactor || amount_8_bytes_be.
 * Returns hex-encoded composite (input to ACE-GF Argon2id). Or "error:...".
 */
export function custody_build_composite_credential_with_amount(user_cred: string, admin_factor_hex: string, amount: bigint): string;

/**
 * Decrypt an AdminFactor from an Arweave backup.
 * Returns hex-encoded AdminFactor (32 bytes), or "error:...".
 */
export function custody_decrypt_backup(ciphertext_hex: string, backup_key_hex: string): string;

/**
 * Decrypt a message from a user (AdminFactor share).
 * Returns hex-encoded plaintext, or "error:...".
 *
 * # Arguments
 * * `package_hex` - The E2E package (ephemeral_pubkey || nonce || ciphertext+tag)
 * * `authority_secret_hex` - Authority's X25519 secret key (hex)
 */
export function custody_decrypt_from_user(package_hex: string, authority_secret_hex: string): string;

/**
 * Derive a backup encryption key from REV and a personal context.
 * Returns hex-encoded 32-byte key, or "error:..." on failure.
 *
 * # Arguments
 * * `rev_hex` - REV as hex string (32 hex chars = 16 bytes UUID)
 * * `recipient_index` - Recipient index for context isolation
 */
export function custody_derive_backup_key(rev_hex: string, recipient_index: number): string;

/**
 * Derive a backup encryption key from REV with institutional context isolation.
 * Returns hex-encoded 32-byte key, or "error:..." on failure.
 *
 * Each (entity_id, domain, index) triple produces a cryptographically isolated key,
 * ensuring that different vaults / sub-accounts within the same entity cannot
 * cross-access each other's encrypted AdminFactors.
 *
 * # Arguments
 * * `rev_hex`   - REV as hex string (32 hex chars = 16 bytes UUID)
 * * `entity_id` - Organization identifier (e.g., "corp-abc-123")
 * * `domain`    - Vault purpose (e.g., "OperatingFund", "MnAEscrow")
 * * `index`     - Vault index within this entity/domain
 */
export function custody_derive_backup_key_institutional(rev_hex: string, entity_id: string, domain: string, index: number): string;

/**
 * Encrypt an AdminFactor for backup on Arweave.
 * Returns hex-encoded ciphertext (nonce || encrypted data), or "error:...".
 */
export function custody_encrypt_backup(admin_factor_hex: string, backup_key_hex: string): string;

/**
 * Encrypt a message (AdminFactor share) for an authority.
 * Returns: { package_hex, ephemeral_pubkey_hex }
 *
 * # Arguments
 * * `message_hex` - Message to encrypt (hex-encoded)
 * * `authority_pubkey_hex` - Authority's X25519 public key (hex, 64 chars = 32 bytes)
 */
export function custody_encrypt_for_authority(message_hex: string, authority_pubkey_hex: string): any;

/**
 * Generate a new random AdminFactor (256-bit).
 * Returns: { admin_factor_hex: "..." }
 */
export function custody_generate_admin_factor(): any;

/**
 * Generate an X25519 keypair for an authority.
 * Returns: { public_key_hex, secret_key_hex }
 */
export function custody_generate_keypair(): any;

/**
 * Generate credentials for a new recipient path.
 * Returns: { index, label, user_cred, user_cred_entropy_hex, admin_factor_hex, context }
 *
 * # Arguments
 * * `index` - Recipient index (1-based)
 * * `label` - Human-readable label (e.g., "Partner A")
 */
export function custody_generate_path(index: number, label: string): any;

/**
 * Pack AdminFactor and amount into a blob (hex).
 * Blob = AdminFactor (32 bytes) || amount (8 bytes big-endian u64).
 * Returns blob hex, or "error:..." on failure.
 */
export function custody_pack_admin_factor_with_amount(admin_factor_hex: string, amount: bigint): string;

/**
 * Parse blob (hex) into AdminFactor hex and amount.
 * Returns JSON string: { "admin_factor_hex": "...", "amount": 123 } or "error:...".
 */
export function custody_parse_admin_factor_with_amount(blob_hex: string): string;

/**
 * Reconstruct a secret from Shamir shares.
 * Returns hex-encoded secret, or "error:...".
 *
 * # Arguments
 * * `shares_json` - JSON array string: [{"index": 1, "data_hex": "..."}, ...]
 */
export function custody_shamir_reconstruct(shares_json: string): string;

/**
 * Split a secret into N shares with threshold T.
 * Returns JSON array of { index, data_hex } objects.
 *
 * # Arguments
 * * `secret_hex` - Secret to split (hex-encoded)
 * * `total` - Total number of shares (e.g., 3)
 * * `threshold` - Minimum shares to reconstruct (e.g., 2)
 */
export function custody_shamir_split(secret_hex: string, total: number, threshold: number): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly custody_admin_factor_fingerprint: (a: number, b: number) => [number, number];
    readonly custody_build_acegf_context: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly custody_build_composite: (a: number, b: number, c: number, d: number) => [number, number];
    readonly custody_build_composite_credential_with_amount: (a: number, b: number, c: number, d: number, e: bigint) => [number, number];
    readonly custody_decrypt_backup: (a: number, b: number, c: number, d: number) => [number, number];
    readonly custody_decrypt_from_user: (a: number, b: number, c: number, d: number) => [number, number];
    readonly custody_derive_backup_key: (a: number, b: number, c: number) => [number, number];
    readonly custody_derive_backup_key_institutional: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly custody_encrypt_backup: (a: number, b: number, c: number, d: number) => [number, number];
    readonly custody_encrypt_for_authority: (a: number, b: number, c: number, d: number) => any;
    readonly custody_generate_admin_factor: () => any;
    readonly custody_generate_keypair: () => any;
    readonly custody_generate_path: (a: number, b: number, c: number) => any;
    readonly custody_pack_admin_factor_with_amount: (a: number, b: number, c: bigint) => [number, number];
    readonly custody_parse_admin_factor_with_amount: (a: number, b: number) => [number, number];
    readonly custody_shamir_reconstruct: (a: number, b: number) => [number, number];
    readonly custody_shamir_split: (a: number, b: number, c: number, d: number) => any;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
