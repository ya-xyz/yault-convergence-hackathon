/* tslint:disable */
/* eslint-disable */
/**
 * Decrypt with mnemonic - returns base64-encoded plaintext on success, or "error:..." on failure
 */
export function acegf_decrypt_with_mnemonic_wasm(mnemonic: string, passphrase: string, ephemeral_pub_b64: string, encrypted_aes_key_b64: string, iv_b64: string, encrypted_data: Uint8Array): string;
/**
 * Same as change_passphrase but with AdminFactor as secondary_passphrase (for path credential generation).
 * Use for wallets that were CREATED with secondary. Returns new mnemonic on success, None on failure.
 */
export function acegf_change_passphrase_with_admin_wasm(existing_mnemonic: string, existing_passphrase: string, new_passphrase: string, admin_factor: string): string | undefined;
export function view_wallet_rev32_with_secondary_wasm(mnemonic: string, passphrase: string, secondary_passphrase?: string | null): any;
/**
 * Get EVM address from mnemonic
 *
 * Returns the same address for all EVM chains (Ethereum, BSC, Polygon, etc.)
 * since they all use the same address derivation.
 *
 * Parameters:
 * - mnemonic: ACE-GF mnemonic
 * - passphrase: wallet passphrase
 *
 * Returns: checksummed address (EIP-55 format, e.g., "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"),
 *          or "error:..." on failure
 */
export function evm_get_address(mnemonic: string, passphrase: string): string;
/**
 * Sign a Solana serialized transaction with context isolation (passphrase path)
 */
export function solana_sign_transaction_with_context(mnemonic: string, passphrase: string, context: string, serialized_tx_base64: string): string;
/**
 * Get Associated Token Account address
 *
 * Params:
 * - wallet: wallet address (base58)
 * - mint: Token mint address (base58)
 *
 * Returns: ATA address (base58)
 */
export function solana_get_ata_address(wallet: string, mint: string): string;
/**
 * Get Bitcoin address from mnemonic
 *
 * Returns Native SegWit address (bc1q...) for mainnet
 *
 * Parameters:
 * - mnemonic: ACE-GF mnemonic
 * - passphrase: wallet passphrase
 * - testnet: true for testnet (tb1q...), false for mainnet (bc1q...)
 *
 * Returns: Bitcoin address or "error:..." on failure
 */
export function bitcoin_get_address(mnemonic: string, passphrase: string, testnet: boolean): string;
/**
 * View REV32 wallet (restore from 24-word mnemonic)
 * Automatically detects REV32 format and uses the new derivation path
 */
export function view_wallet_rev32_wasm(mnemonic: string, passphrase: string): any;
/**
 * Sign EVM personal message using PRF key
 */
export function evm_sign_personal_message_with_prf(mnemonic: string, prf_key: Uint8Array, message: string): string;
/**
 * Sign message using PRF key
 */
export function acegf_sign_message_with_prf_wasm(mnemonic: string, prf_key: Uint8Array, message: Uint8Array, curve: number): string;
/**
 * Convert a Bitcoin bech32/bech32m address between mainnet and testnet
 *
 * Examples:
 *   bc1p... → tb1p... (mainnet to testnet)
 *   tb1p... → bc1p... (testnet to mainnet)
 *   bc1q... → tb1q... (mainnet to testnet)
 *
 * Parameters:
 * - address: Bitcoin bech32/bech32m address
 * - testnet: true to convert to testnet (tb1...), false for mainnet (bc1...)
 *
 * Returns: converted address, or "error:..." on failure
 */
export function bitcoin_convert_address_network(address: string, testnet: boolean): string;
/**
 * Sign a Bitcoin SegWit transaction
 *
 * Parameters:
 * - mnemonic: ACE-GF mnemonic
 * - passphrase: wallet passphrase
 * - tx_json: JSON string containing unsigned transaction data
 *   Format: {
 *     "version": 2,
 *     "inputs": [{"txid": "hex", "vout": 0, "value": 10000, "sequence": 4294967293}],
 *     "outputs": [{"value": 9000, "script_pubkey": "hex"}],
 *     "locktime": 0
 *   }
 *
 * Returns: signed transaction as hex string, or "error:..." on failure
 */
export function bitcoin_sign_transaction(mnemonic: string, passphrase: string, tx_json: string): string;
/**
 * Get Bitcoin Taproot address from mnemonic
 *
 * Returns Taproot address (bc1p... for mainnet, tb1p... for testnet)
 *
 * Parameters:
 * - mnemonic: ACE-GF mnemonic
 * - passphrase: wallet passphrase
 * - testnet: true for testnet (tb1p...), false for mainnet (bc1p...)
 *
 * Returns: Bitcoin Taproot address or "error:..." on failure
 */
export function bitcoin_get_taproot_address(mnemonic: string, passphrase: string, testnet: boolean): string;
/**
 * Sign EVM typed data with context isolation (passphrase path)
 */
export function evm_sign_typed_data_with_context(mnemonic: string, passphrase: string, context: string, typed_data_hash: string): string;
/**
 * Sign an arbitrary message with Solana context-derived Ed25519 key (passphrase path)
 */
export function solana_sign_message_with_context(mnemonic: string, passphrase: string, context: string, message: string): string;
/**
 * Sign EVM EIP-1559 Transaction using PRF key
 */
export function evm_sign_eip1559_transaction_with_prf(mnemonic: string, prf_key: Uint8Array, chain_id: bigint, nonce: string, max_priority_fee_per_gas: string, max_fee_per_gas: string, gas_limit: string, to: string, value: string, data: string): string;
/**
 * Get EVM address with context isolation (PRF path)
 */
export function evm_get_address_with_context_prf(mnemonic: string, prf_key: Uint8Array, context: string): string;
/**
 * Sign EVM typed data using PRF key
 */
export function evm_sign_typed_data_with_prf(mnemonic: string, prf_key: Uint8Array, typed_data_hash: string): string;
/**
 * Compute transaction hash from signed transaction
 *
 * Parameters:
 * - signed_tx: signed transaction hex string
 *
 * Returns: transaction hash as hex string (e.g., "0x..."),
 *          or "error:..." on failure
 */
export function evm_compute_tx_hash(signed_tx: string): string;
/**
 * Decrypt with PRF key (no passphrase in JS)
 */
export function acegf_decrypt_with_prf_wasm(mnemonic: string, prf_key: Uint8Array, ephemeral_pub_b64: string, encrypted_aes_key_b64: string, iv_b64: string, encrypted_data: Uint8Array): string;
/**
 * Sign EVM personal message with context isolation (PRF path)
 */
export function evm_sign_personal_message_with_context_prf(mnemonic: string, prf_key: Uint8Array, context: string, message: string): string;
export function solana_sign_system_transfer_with_secondary(mnemonic: string, passphrase: string, secondary_passphrase: string | null | undefined, to_pubkey: string, lamports: bigint, recent_blockhash: string): string;
/**
 * Get owner public key for registry authorization
 * Returns base64-encoded Ed25519 public key, or "error:..." on failure
 */
export function vadar_get_owner_pubkey(password: string, normalized_email: string): string;
/**
 * Encode ERC20 transfer function call data
 *
 * Use this to build the `data` field for ERC20 token transfers.
 *
 * Parameters:
 * - to: recipient address (hex string)
 * - amount: amount to transfer in token's smallest unit (hex string)
 *
 * Returns: encoded function call data as hex string,
 *          or "error:..." on failure
 */
export function evm_encode_erc20_transfer(to: string, amount: string): string;
/**
 * Sign Solana system transfer using PRF key
 */
export function solana_sign_system_transfer_with_prf(mnemonic: string, prf_key: Uint8Array, to_pubkey: string, lamports: bigint, recent_blockhash: string): string;
/**
 * Normalize email for VA-DAR
 * - Lowercase
 * - Trim whitespace
 * - Remove dots from local part
 * - Remove +suffix from local part
 */
export function vadar_normalize_email(email: string): string;
/**
 * Compute commit hash of SA2 artifact
 * Returns hex-encoded SHA256 hash, or "error:..." on failure
 */
export function vadar_compute_commit(sa2_base64: string): string;
/**
 * DEBUG: Test unseal with exact parameters and return detailed results
 */
export function debug_unseal_test(mnemonic: string, passphrase: string, admin_factor: string): string;
/**
 * XIdentity sign - returns base64 signature on success, or "error:..." on failure
 */
export function acegf_xidentity_sign_wasm(mnemonic: string, passphrase: string, message: Uint8Array): string;
/**
 * Sign an EIP-1559 Transaction (Type 2)
 *
 * This is the modern transaction format with dynamic fee market.
 * Preferred for Ethereum mainnet and most L2s.
 *
 * Parameters:
 * - mnemonic: ACE-GF mnemonic
 * - passphrase: wallet passphrase
 * - chain_id: EVM chain ID
 * - nonce: transaction nonce (hex string)
 * - max_priority_fee_per_gas: tip to miner in wei (hex string)
 * - max_fee_per_gas: maximum total fee in wei (hex string)
 * - gas_limit: gas limit (hex string)
 * - to: recipient address (hex string with 0x prefix)
 * - value: amount in wei (hex string)
 * - data: transaction data (hex string)
 *
 * Returns: signed transaction as hex string (with 0x02 type prefix),
 *          or "error:..." on failure
 */
export function evm_sign_eip1559_transaction(mnemonic: string, passphrase: string, chain_id: bigint, nonce: string, max_priority_fee_per_gas: string, max_fee_per_gas: string, gas_limit: string, to: string, value: string, data: string): string;
/**
 * Unseal SA2 artifact to recover mnemonic
 * Returns mnemonic string, or "error:..." on failure
 */
export function vadar_unseal_sa2(sa2_base64: string, password: string, normalized_email: string): string;
/**
 * Sign message - returns base64 signature on success, or "error:..." on failure
 */
export function acegf_sign_message_wasm(mnemonic: string, passphrase: string, message: Uint8Array, curve: number): string;
/**
 * Sign a personal message (EIP-191)
 *
 * Used for "Sign Message" functionality in wallets.
 * The message is prefixed with "\x19Ethereum Signed Message:\n{length}"
 *
 * Parameters:
 * - mnemonic: ACE-GF mnemonic
 * - passphrase: wallet passphrase
 * - message: raw message as UTF-8 string
 *
 * Returns: signature as hex string (65 bytes: r[32] + s[32] + v[1]),
 *          or "error:..." on failure
 */
export function evm_sign_personal_message(mnemonic: string, passphrase: string, message: string): string;
/**
 * Sign EVM EIP-1559 transaction with context isolation (passphrase path)
 */
export function evm_sign_eip1559_transaction_with_context(mnemonic: string, passphrase: string, context: string, chain_id: bigint, nonce: string, max_priority_fee_per_gas: string, max_fee_per_gas: string, gas_limit: string, to: string, value: string, data: string): string;
/**
 * Change passphrase for wallets created WITHOUT secondary (e.g. extension via generate_wasm).
 * Unseals with (existing_passphrase, None), seals with (new_passphrase, Some(admin_factor)).
 * Use this for extension wallets. Returns new mnemonic on success, None on failure.
 */
export function acegf_change_passphrase_add_admin_wasm(existing_mnemonic: string, existing_passphrase: string, new_passphrase: string, admin_factor: string): string | undefined;
/**
 * Sign externally serialized transaction (Legacy Transaction)
 *
 * Params:
 * - mnemonic: ACE-GF mnemonic
 * - passphrase: passphrase
 * - serialized_tx_base64: base64-encoded serialized transaction
 *
 * Returns: base64-encoded signed transaction, or "error:..." on failure
 */
export function solana_sign_transaction(mnemonic: string, passphrase: string, serialized_tx_base64: string): string;
/**
 * View wallet using PRF key (skips passphrase decryption in JS)
 */
export function view_wallet_with_prf_wasm(mnemonic: string, prf_key: Uint8Array): any;
export function generate_with_secondary_wasm(passphrase: string, secondary_passphrase?: string | null): any;
/**
 * XIdentity verify - returns "true", "false", or "error:..." on failure
 */
export function acegf_xidentity_verify_wasm(xidentity_b64: string, message: Uint8Array, signature: Uint8Array): string;
export function init_panic_hook(): void;
export function view_wallet_wasm(mnemonic: string, passphrase: string): any;
/**
 * Get EVM address using PRF key
 */
export function evm_get_address_with_prf(mnemonic: string, prf_key: Uint8Array): string;
/**
 * Sign EVM Legacy Transaction using PRF key
 */
export function evm_sign_legacy_transaction_with_prf(mnemonic: string, prf_key: Uint8Array, chain_id: bigint, nonce: string, gas_price: string, gas_limit: string, to: string, value: string, data: string): string;
/**
 * Seal mnemonic into SA2 artifact
 * Returns base64-encoded SA2, or "error:..." on failure
 */
export function vadar_seal_sa2(mnemonic: string, password: string, normalized_email: string): string;
/**
 * Compute DH shared key using PRF key
 */
export function acegf_compute_dh_key_with_prf_wasm(mnemonic: string, prf_key: Uint8Array, peer_pub_b64: string): string;
/**
 * SPL Token transfer signing (with create target ATA)
 *
 * Use when recipient ATA does not exist. Transaction includes createAssociatedTokenAccount + Transfer.
 *
 * Params:
 * - mnemonic: mnemonic
 * - passphrase: passphrase
 * - mint: SPL Token mint address (base58)
 * - to_wallet: recipient wallet address (base58, not ATA; ATA is computed inside)
 * - amount: raw amount (already multiplied by 10^decimals)
 * - recent_blockhash: recent block hash
 *
 * Returns: base64-encoded signed transaction
 */
export function solana_sign_spl_transfer_with_create_ata(mnemonic: string, passphrase: string, mint: string, to_wallet: string, amount: bigint, recent_blockhash: string): string;
export function view_wallet_unified_with_secondary_wasm(mnemonic: string, passphrase: string, secondary_passphrase?: string | null): any;
export function generate_wasm(passphrase: string): any;
export function acegf_change_passphrase_wasm(mnemonic: string, old_passphrase: string, new_passphrase: string): string | undefined;
/**
 * Generate scriptPubKey for any Bitcoin address
 *
 * Supports all address types:
 * - Bech32/Bech32m: bc1q... (P2WPKH), bc1p... (P2TR), tb1q..., tb1p...
 * - Legacy Base58Check: 1... (P2PKH), 3... (P2SH), m.../n... (testnet P2PKH), 2... (testnet P2SH)
 *
 * Returns: scriptPubKey as hex string, or "error:..." on failure
 */
export function bitcoin_address_to_script_pubkey(address: string): string;
/**
 * View wallet with context isolation (passphrase path)
 * Returns 7 chain addresses for the given context, or error for legacy wallets.
 */
export function view_wallet_unified_with_context_wasm(mnemonic: string, passphrase: string, context: string): any;
/**
 * Get Solana address with context isolation (PRF path)
 */
export function solana_get_address_with_context_prf(mnemonic: string, prf_key: Uint8Array, context: string): string;
/**
 * Compute Discovery ID from password and normalized email
 * Returns hex-encoded 32-byte discovery ID, or "error:..." on failure
 */
export function vadar_compute_discovery_id(password: string, normalized_email: string): string;
/**
 * Encrypt data for a recipient's xidentity public key
 * Returns JSON: { ephemeral_pub, encrypted_aes_key, iv, encrypted_data }
 * or "error:..." on failure
 */
export function acegf_encrypt_for_xidentity(recipient_xidentity_b64: string, plaintext: Uint8Array): string;
/**
 * Sign typed structured data (EIP-712)
 *
 * Used for permit signatures, NFT marketplace approvals, etc.
 * The typed data hash should be pre-computed by the frontend.
 *
 * Parameters:
 * - mnemonic: ACE-GF mnemonic
 * - passphrase: wallet passphrase
 * - typed_data_hash: pre-computed EIP-712 hash (32 bytes as hex string)
 *
 * Returns: signature as hex string (65 bytes: r[32] + s[32] + v[1]),
 *          or "error:..." on failure
 */
export function evm_sign_typed_data(mnemonic: string, passphrase: string, typed_data_hash: string): string;
/**
 * Sign an arbitrary message with Solana context-derived Ed25519 key (PRF path)
 */
export function solana_sign_message_with_context_prf(mnemonic: string, prf_key: Uint8Array, context: string, message: string): string;
/**
 * Sign registry update for create/update operations
 * Returns base64-encoded Ed25519 signature, or "error:..." on failure
 */
export function vadar_sign_registry_update(password: string, normalized_email: string, discovery_id: string, cid: string, version: bigint, commit: string): string;
/**
 * Sign Solana external transaction using PRF key
 */
export function solana_sign_transaction_with_prf(mnemonic: string, prf_key: Uint8Array, serialized_tx_base64: string): string;
/**
 * Generate a new REV32 wallet with passphrase
 * Returns JSON: { mnemonic, solana_address, evm_address, bitcoin_address, cosmos_address, polkadot_address, xaddress, xidentity }
 * or JSON: { error: true, message: "..." }
 */
export function generate_rev32_wasm(passphrase: string): any;
/**
 * Sign a Solana serialized transaction with context isolation (PRF path)
 */
export function solana_sign_transaction_with_context_prf(mnemonic: string, prf_key: Uint8Array, context: string, serialized_tx_base64: string): string;
export function view_wallet_with_secondary_wasm(mnemonic: string, passphrase: string, secondary_passphrase?: string | null): any;
/**
 * Sign message - returns signature bytes on success, or error string prefixed with "error:" on failure
 */
export function acegf_sign_message_with_secondary_wasm(mnemonic: string, passphrase: string, secondary_passphrase: string | null | undefined, message: Uint8Array, curve: number): string;
/**
 * Compute DH shared key - returns base64-encoded key on success, or "error:..." on failure
 */
export function acegf_compute_dh_key_wasm(mnemonic: string, passphrase: string, peer_pub_b64: string): string;
/**
 * Sign an EIP-1559 Transaction with secondary passphrase (e.g. admin factor)
 *
 * Same as evm_sign_eip1559_transaction but combines passphrase with secondary_passphrase
 * for key derivation. This allows recipients holding 3-factor credentials
 * (mnemonic + passphrase + admin_factor) to sign as the wallet owner.
 */
export function evm_sign_eip1559_transaction_with_secondary(mnemonic: string, passphrase: string, secondary_passphrase: string | null | undefined, chain_id: bigint, nonce: string, max_priority_fee_per_gas: string, max_fee_per_gas: string, gas_limit: string, to: string, value: string, data: string): string;
/**
 * Sign EVM personal message with context isolation (passphrase path)
 */
export function evm_sign_personal_message_with_context(mnemonic: string, passphrase: string, context: string, message: string): string;
/**
 * Get Solana address with context isolation (passphrase path)
 */
export function solana_get_address_with_context(mnemonic: string, passphrase: string, context: string): string;
/**
 * Sign EVM EIP-1559 transaction with context isolation (PRF path)
 */
export function evm_sign_eip1559_transaction_with_context_prf(mnemonic: string, prf_key: Uint8Array, context: string, chain_id: bigint, nonce: string, max_priority_fee_per_gas: string, max_fee_per_gas: string, gas_limit: string, to: string, value: string, data: string): string;
/**
 * Encode ERC20 approve function call data
 *
 * Use this to approve a spender (DEX router) to spend tokens.
 * For unlimited approval, use max uint256: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
 *
 * Parameters:
 * - spender: spender address (DEX router, etc.)
 * - amount: amount to approve in token's smallest unit (hex string)
 *
 * Returns: encoded function call data as hex string,
 *          or "error:..." on failure
 */
export function evm_encode_erc20_approve(spender: string, amount: string): string;
/**
 * SPL Token transfer signing
 *
 * Params:
 * - mnemonic: mnemonic
 * - passphrase: passphrase
 * - mint: SPL Token mint address (base58)
 * - to_wallet: recipient wallet address (base58, not ATA; ATA is computed inside)
 * - amount: raw amount (already multiplied by 10^decimals)
 * - recent_blockhash: recent block hash
 *
 * Returns: base64-encoded signed transaction
 */
export function solana_sign_spl_transfer(mnemonic: string, passphrase: string, mint: string, to_wallet: string, amount: bigint, recent_blockhash: string): string;
/**
 * Sign a Legacy Transaction (Type 0)
 *
 * This is the original Ethereum transaction format with EIP-155 replay protection.
 * Compatible with all EVM chains.
 *
 * Parameters:
 * - mnemonic: ACE-GF mnemonic
 * - passphrase: wallet passphrase
 * - chain_id: EVM chain ID (1=Ethereum, 56=BSC, 137=Polygon, etc.)
 * - nonce: transaction nonce (hex string, e.g., "0x0")
 * - gas_price: gas price in wei (hex string, e.g., "0x3b9aca00" for 1 gwei)
 * - gas_limit: gas limit (hex string, e.g., "0x5208" for 21000)
 * - to: recipient address (hex string with 0x prefix)
 * - value: amount in wei (hex string)
 * - data: transaction data (hex string, use "0x" for empty)
 *
 * Returns: signed transaction as hex string (ready for eth_sendRawTransaction),
 *          or "error:..." on failure
 */
export function evm_sign_legacy_transaction(mnemonic: string, passphrase: string, chain_id: bigint, nonce: string, gas_price: string, gas_limit: string, to: string, value: string, data: string): string;
/**
 * Sign a Bitcoin SegWit transaction using PRF key (no passphrase in JS)
 *
 * Parameters same as bitcoin_sign_transaction, but uses prf_key instead of passphrase.
 *
 * Returns: signed transaction as hex string, or "error:..." on failure
 */
export function bitcoin_sign_transaction_prf(mnemonic: string, prf_key: Uint8Array, tx_json: string): string;
/**
 * Get EVM address with context isolation (passphrase path)
 */
export function evm_get_address_with_context(mnemonic: string, passphrase: string, context: string): string;
/**
 * Generate a new REV32 wallet with passphrase and optional secondary passphrase
 */
export function generate_rev32_with_secondary_wasm(passphrase: string, secondary_passphrase?: string | null): any;
/**
 * Unified wallet view - auto-detects UUID vs REV32 format
 * Works with both 18-word (legacy UUID) and 24-word (REV32) mnemonics
 */
export function view_wallet_unified_wasm(mnemonic: string, passphrase: string): any;
/**
 * View wallet with context isolation (PRF path)
 * Uses PRF key → base_key → identity_root → context-isolated seeds
 */
export function view_wallet_with_context_prf_wasm(mnemonic: string, prf_key: Uint8Array, context: string): any;
export function solana_sign_system_transfer(mnemonic: string, passphrase: string, to_pubkey: string, lamports: bigint, recent_blockhash: string): string;
/**
 * Sign EVM typed data with context isolation (PRF path)
 */
export function evm_sign_typed_data_with_context_prf(mnemonic: string, prf_key: Uint8Array, context: string, typed_data_hash: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly acegf_change_passphrase_add_admin_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
  readonly acegf_change_passphrase_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly acegf_change_passphrase_with_admin_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
  readonly acegf_compute_dh_key_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly acegf_compute_dh_key_with_prf_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly acegf_decrypt_with_mnemonic_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => void;
  readonly acegf_decrypt_with_prf_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => void;
  readonly acegf_encrypt_for_xidentity: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly acegf_sign_message_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
  readonly acegf_sign_message_with_prf_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
  readonly acegf_sign_message_with_secondary_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
  readonly acegf_xidentity_sign_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly acegf_xidentity_verify_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly bitcoin_address_to_script_pubkey: (a: number, b: number, c: number) => void;
  readonly bitcoin_convert_address_network: (a: number, b: number, c: number, d: number) => void;
  readonly bitcoin_get_address: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly bitcoin_get_taproot_address: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly bitcoin_sign_transaction: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly bitcoin_sign_transaction_prf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly debug_unseal_test: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly evm_compute_tx_hash: (a: number, b: number, c: number) => void;
  readonly evm_encode_erc20_approve: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly evm_encode_erc20_transfer: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly evm_get_address: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly evm_get_address_with_context: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly evm_get_address_with_context_prf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly evm_get_address_with_prf: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly evm_sign_eip1559_transaction: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number) => void;
  readonly evm_sign_eip1559_transaction_with_context: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number) => void;
  readonly evm_sign_eip1559_transaction_with_context_prf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number) => void;
  readonly evm_sign_eip1559_transaction_with_prf: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number) => void;
  readonly evm_sign_eip1559_transaction_with_secondary: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number) => void;
  readonly evm_sign_legacy_transaction: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number) => void;
  readonly evm_sign_legacy_transaction_with_prf: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number) => void;
  readonly evm_sign_personal_message: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly evm_sign_personal_message_with_context: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
  readonly evm_sign_personal_message_with_context_prf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
  readonly evm_sign_personal_message_with_prf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly evm_sign_typed_data: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly evm_sign_typed_data_with_context: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
  readonly evm_sign_typed_data_with_context_prf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
  readonly evm_sign_typed_data_with_prf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly generate_rev32_wasm: (a: number, b: number) => number;
  readonly generate_rev32_with_secondary_wasm: (a: number, b: number, c: number, d: number) => number;
  readonly generate_wasm: (a: number, b: number) => number;
  readonly generate_with_secondary_wasm: (a: number, b: number, c: number, d: number) => number;
  readonly init_panic_hook: () => void;
  readonly solana_get_address_with_context: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly solana_get_address_with_context_prf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly solana_get_ata_address: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly solana_sign_message_with_context: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
  readonly solana_sign_message_with_context_prf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
  readonly solana_sign_spl_transfer: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: bigint, k: number, l: number) => void;
  readonly solana_sign_spl_transfer_with_create_ata: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: bigint, k: number, l: number) => void;
  readonly solana_sign_system_transfer: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint, i: number, j: number) => void;
  readonly solana_sign_system_transfer_with_prf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint, i: number, j: number) => void;
  readonly solana_sign_system_transfer_with_secondary: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: bigint, k: number, l: number) => void;
  readonly solana_sign_transaction: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly solana_sign_transaction_with_context: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
  readonly solana_sign_transaction_with_context_prf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
  readonly solana_sign_transaction_with_prf: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly vadar_compute_commit: (a: number, b: number, c: number) => void;
  readonly vadar_compute_discovery_id: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly vadar_get_owner_pubkey: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly vadar_normalize_email: (a: number, b: number, c: number) => void;
  readonly vadar_seal_sa2: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly vadar_sign_registry_update: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: bigint, k: number, l: number) => void;
  readonly vadar_unseal_sa2: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly view_wallet_rev32_wasm: (a: number, b: number, c: number, d: number) => number;
  readonly view_wallet_rev32_with_secondary_wasm: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
  readonly view_wallet_unified_wasm: (a: number, b: number, c: number, d: number) => number;
  readonly view_wallet_unified_with_context_wasm: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
  readonly view_wallet_unified_with_secondary_wasm: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
  readonly view_wallet_wasm: (a: number, b: number, c: number, d: number) => number;
  readonly view_wallet_with_context_prf_wasm: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
  readonly view_wallet_with_prf_wasm: (a: number, b: number, c: number, d: number) => number;
  readonly view_wallet_with_secondary_wasm: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
  readonly __wbindgen_export: (a: number) => void;
  readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export3: (a: number, b: number) => number;
  readonly __wbindgen_export4: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
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
