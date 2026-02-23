let wasm;

let heap = new Array(128).fill(undefined);

heap.push(undefined, null, true, false);

function getObject(idx) { return heap[idx]; }

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });

cachedTextDecoder.decode();

const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let heap_next = heap.length;

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        wasm.__wbindgen_export(addHeapObject(e));
    }
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function dropObject(idx) {
    if (idx < 132) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let WASM_VECTOR_LEN = 0;

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    }
}

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedDataViewMemory0 = null;

function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}
/**
 * Decrypt with mnemonic - returns base64-encoded plaintext on success, or "error:..." on failure
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} ephemeral_pub_b64
 * @param {string} encrypted_aes_key_b64
 * @param {string} iv_b64
 * @param {Uint8Array} encrypted_data
 * @returns {string}
 */
export function acegf_decrypt_with_mnemonic_wasm(mnemonic, passphrase, ephemeral_pub_b64, encrypted_aes_key_b64, iv_b64, encrypted_data) {
    let deferred7_0;
    let deferred7_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(ephemeral_pub_b64, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(encrypted_aes_key_b64, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(iv_b64, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArray8ToWasm0(encrypted_data, wasm.__wbindgen_export3);
        const len5 = WASM_VECTOR_LEN;
        wasm.acegf_decrypt_with_mnemonic_wasm(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred7_0 = r0;
        deferred7_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred7_0, deferred7_1, 1);
    }
}

/**
 * Same as change_passphrase but with AdminFactor as secondary_passphrase (for path credential generation).
 * Use for wallets that were CREATED with secondary. Returns new mnemonic on success, None on failure.
 * @param {string} existing_mnemonic
 * @param {string} existing_passphrase
 * @param {string} new_passphrase
 * @param {string} admin_factor
 * @returns {string | undefined}
 */
export function acegf_change_passphrase_with_admin_wasm(existing_mnemonic, existing_passphrase, new_passphrase, admin_factor) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(existing_mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(existing_passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(new_passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(admin_factor, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        wasm.acegf_change_passphrase_with_admin_wasm(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        let v5;
        if (r0 !== 0) {
            v5 = getStringFromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
        }
        return v5;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string | null} [secondary_passphrase]
 * @returns {any}
 */
export function view_wallet_rev32_with_secondary_wasm(mnemonic, passphrase, secondary_passphrase) {
    const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len1 = WASM_VECTOR_LEN;
    var ptr2 = isLikeNone(secondary_passphrase) ? 0 : passStringToWasm0(secondary_passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    var len2 = WASM_VECTOR_LEN;
    const ret = wasm.view_wallet_rev32_with_secondary_wasm(ptr0, len0, ptr1, len1, ptr2, len2);
    return takeObject(ret);
}

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
 * @param {string} mnemonic
 * @param {string} passphrase
 * @returns {string}
 */
export function evm_get_address(mnemonic, passphrase) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        wasm.evm_get_address(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred3_0 = r0;
        deferred3_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Sign a Solana serialized transaction with context isolation (passphrase path)
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} context
 * @param {string} serialized_tx_base64
 * @returns {string}
 */
export function solana_sign_transaction_with_context(mnemonic, passphrase, context, serialized_tx_base64) {
    let deferred5_0;
    let deferred5_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(context, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(serialized_tx_base64, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        wasm.solana_sign_transaction_with_context(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred5_0 = r0;
        deferred5_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred5_0, deferred5_1, 1);
    }
}

/**
 * 获取 Associated Token Account 地址
 *
 * 参数:
 * - wallet: 钱包地址 (base58)
 * - mint: Token mint 地址 (base58)
 *
 * 返回: ATA 地址 (base58)
 * @param {string} wallet
 * @param {string} mint
 * @returns {string}
 */
export function solana_get_ata_address(wallet, mint) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(wallet, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(mint, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        wasm.solana_get_ata_address(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred3_0 = r0;
        deferred3_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred3_0, deferred3_1, 1);
    }
}

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
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {boolean} testnet
 * @returns {string}
 */
export function bitcoin_get_address(mnemonic, passphrase, testnet) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        wasm.bitcoin_get_address(retptr, ptr0, len0, ptr1, len1, testnet);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred3_0 = r0;
        deferred3_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred3_0, deferred3_1, 1);
    }
}

/**
 * View REV32 wallet (restore from 24-word mnemonic)
 * Automatically detects REV32 format and uses the new derivation path
 * @param {string} mnemonic
 * @param {string} passphrase
 * @returns {any}
 */
export function view_wallet_rev32_wasm(mnemonic, passphrase) {
    const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.view_wallet_rev32_wasm(ptr0, len0, ptr1, len1);
    return takeObject(ret);
}

/**
 * Sign EVM personal message using PRF key
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @param {string} message
 * @returns {string}
 */
export function evm_sign_personal_message_with_prf(mnemonic, prf_key, message) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(message, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        wasm.evm_sign_personal_message_with_prf(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Sign message using PRF key
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @param {Uint8Array} message
 * @param {number} curve
 * @returns {string}
 */
export function acegf_sign_message_with_prf_wasm(mnemonic, prf_key, message, curve) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(message, wasm.__wbindgen_export3);
        const len2 = WASM_VECTOR_LEN;
        wasm.acegf_sign_message_with_prf_wasm(retptr, ptr0, len0, ptr1, len1, ptr2, len2, curve);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

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
 * @param {string} address
 * @param {boolean} testnet
 * @returns {string}
 */
export function bitcoin_convert_address_network(address, testnet) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(address, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        wasm.bitcoin_convert_address_network(retptr, ptr0, len0, testnet);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred2_0, deferred2_1, 1);
    }
}

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
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} tx_json
 * @returns {string}
 */
export function bitcoin_sign_transaction(mnemonic, passphrase, tx_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(tx_json, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        wasm.bitcoin_sign_transaction(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

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
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {boolean} testnet
 * @returns {string}
 */
export function bitcoin_get_taproot_address(mnemonic, passphrase, testnet) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        wasm.bitcoin_get_taproot_address(retptr, ptr0, len0, ptr1, len1, testnet);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred3_0 = r0;
        deferred3_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Sign EVM typed data with context isolation (passphrase path)
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} context
 * @param {string} typed_data_hash
 * @returns {string}
 */
export function evm_sign_typed_data_with_context(mnemonic, passphrase, context, typed_data_hash) {
    let deferred5_0;
    let deferred5_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(context, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(typed_data_hash, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        wasm.evm_sign_typed_data_with_context(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred5_0 = r0;
        deferred5_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Sign an arbitrary message with Solana context-derived Ed25519 key (passphrase path)
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} context
 * @param {string} message
 * @returns {string}
 */
export function solana_sign_message_with_context(mnemonic, passphrase, context, message) {
    let deferred5_0;
    let deferred5_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(context, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(message, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        wasm.solana_sign_message_with_context(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred5_0 = r0;
        deferred5_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Sign EVM EIP-1559 Transaction using PRF key
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @param {bigint} chain_id
 * @param {string} nonce
 * @param {string} max_priority_fee_per_gas
 * @param {string} max_fee_per_gas
 * @param {string} gas_limit
 * @param {string} to
 * @param {string} value
 * @param {string} data
 * @returns {string}
 */
export function evm_sign_eip1559_transaction_with_prf(mnemonic, prf_key, chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit, to, value, data) {
    let deferred10_0;
    let deferred10_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(nonce, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(max_priority_fee_per_gas, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(max_fee_per_gas, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(gas_limit, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passStringToWasm0(to, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passStringToWasm0(value, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len7 = WASM_VECTOR_LEN;
        const ptr8 = passStringToWasm0(data, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len8 = WASM_VECTOR_LEN;
        wasm.evm_sign_eip1559_transaction_with_prf(retptr, ptr0, len0, ptr1, len1, chain_id, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred10_0 = r0;
        deferred10_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred10_0, deferred10_1, 1);
    }
}

/**
 * Get EVM address with context isolation (PRF path)
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @param {string} context
 * @returns {string}
 */
export function evm_get_address_with_context_prf(mnemonic, prf_key, context) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(context, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        wasm.evm_get_address_with_context_prf(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Sign EVM typed data using PRF key
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @param {string} typed_data_hash
 * @returns {string}
 */
export function evm_sign_typed_data_with_prf(mnemonic, prf_key, typed_data_hash) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(typed_data_hash, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        wasm.evm_sign_typed_data_with_prf(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Compute transaction hash from signed transaction
 *
 * Parameters:
 * - signed_tx: signed transaction hex string
 *
 * Returns: transaction hash as hex string (e.g., "0x..."),
 *          or "error:..." on failure
 * @param {string} signed_tx
 * @returns {string}
 */
export function evm_compute_tx_hash(signed_tx) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(signed_tx, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        wasm.evm_compute_tx_hash(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Decrypt with PRF key (no passphrase in JS)
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @param {string} ephemeral_pub_b64
 * @param {string} encrypted_aes_key_b64
 * @param {string} iv_b64
 * @param {Uint8Array} encrypted_data
 * @returns {string}
 */
export function acegf_decrypt_with_prf_wasm(mnemonic, prf_key, ephemeral_pub_b64, encrypted_aes_key_b64, iv_b64, encrypted_data) {
    let deferred7_0;
    let deferred7_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(ephemeral_pub_b64, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(encrypted_aes_key_b64, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(iv_b64, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArray8ToWasm0(encrypted_data, wasm.__wbindgen_export3);
        const len5 = WASM_VECTOR_LEN;
        wasm.acegf_decrypt_with_prf_wasm(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred7_0 = r0;
        deferred7_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred7_0, deferred7_1, 1);
    }
}

/**
 * Sign EVM personal message with context isolation (PRF path)
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @param {string} context
 * @param {string} message
 * @returns {string}
 */
export function evm_sign_personal_message_with_context_prf(mnemonic, prf_key, context, message) {
    let deferred5_0;
    let deferred5_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(context, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(message, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        wasm.evm_sign_personal_message_with_context_prf(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred5_0 = r0;
        deferred5_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred5_0, deferred5_1, 1);
    }
}

/**
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string | null | undefined} secondary_passphrase
 * @param {string} to_pubkey
 * @param {bigint} lamports
 * @param {string} recent_blockhash
 * @returns {string}
 */
export function solana_sign_system_transfer_with_secondary(mnemonic, passphrase, secondary_passphrase, to_pubkey, lamports, recent_blockhash) {
    let deferred6_0;
    let deferred6_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        var ptr2 = isLikeNone(secondary_passphrase) ? 0 : passStringToWasm0(secondary_passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        var len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(to_pubkey, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(recent_blockhash, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len4 = WASM_VECTOR_LEN;
        wasm.solana_sign_system_transfer_with_secondary(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, lamports, ptr4, len4);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred6_0 = r0;
        deferred6_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred6_0, deferred6_1, 1);
    }
}

/**
 * Get owner public key for registry authorization
 * Returns base64-encoded Ed25519 public key, or "error:..." on failure
 * @param {string} password
 * @param {string} normalized_email
 * @returns {string}
 */
export function vadar_get_owner_pubkey(password, normalized_email) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(password, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(normalized_email, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        wasm.vadar_get_owner_pubkey(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred3_0 = r0;
        deferred3_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred3_0, deferred3_1, 1);
    }
}

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
 * @param {string} to
 * @param {string} amount
 * @returns {string}
 */
export function evm_encode_erc20_transfer(to, amount) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(to, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(amount, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        wasm.evm_encode_erc20_transfer(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred3_0 = r0;
        deferred3_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Sign Solana system transfer using PRF key
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @param {string} to_pubkey
 * @param {bigint} lamports
 * @param {string} recent_blockhash
 * @returns {string}
 */
export function solana_sign_system_transfer_with_prf(mnemonic, prf_key, to_pubkey, lamports, recent_blockhash) {
    let deferred5_0;
    let deferred5_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(to_pubkey, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(recent_blockhash, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        wasm.solana_sign_system_transfer_with_prf(retptr, ptr0, len0, ptr1, len1, ptr2, len2, lamports, ptr3, len3);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred5_0 = r0;
        deferred5_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Normalize email for VA-DAR
 * - Lowercase
 * - Trim whitespace
 * - Remove dots from local part
 * - Remove +suffix from local part
 * @param {string} email
 * @returns {string}
 */
export function vadar_normalize_email(email) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(email, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        wasm.vadar_normalize_email(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Compute commit hash of SA2 artifact
 * Returns hex-encoded SHA256 hash, or "error:..." on failure
 * @param {string} sa2_base64
 * @returns {string}
 */
export function vadar_compute_commit(sa2_base64) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(sa2_base64, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        wasm.vadar_compute_commit(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred2_0, deferred2_1, 1);
    }
}

/**
 * DEBUG: Test unseal with exact parameters and return detailed results
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} admin_factor
 * @returns {string}
 */
export function debug_unseal_test(mnemonic, passphrase, admin_factor) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(admin_factor, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        wasm.debug_unseal_test(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

/**
 * XIdentity sign - returns base64 signature on success, or "error:..." on failure
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {Uint8Array} message
 * @returns {string}
 */
export function acegf_xidentity_sign_wasm(mnemonic, passphrase, message) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(message, wasm.__wbindgen_export3);
        const len2 = WASM_VECTOR_LEN;
        wasm.acegf_xidentity_sign_wasm(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

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
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {bigint} chain_id
 * @param {string} nonce
 * @param {string} max_priority_fee_per_gas
 * @param {string} max_fee_per_gas
 * @param {string} gas_limit
 * @param {string} to
 * @param {string} value
 * @param {string} data
 * @returns {string}
 */
export function evm_sign_eip1559_transaction(mnemonic, passphrase, chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit, to, value, data) {
    let deferred10_0;
    let deferred10_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(nonce, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(max_priority_fee_per_gas, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(max_fee_per_gas, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(gas_limit, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passStringToWasm0(to, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passStringToWasm0(value, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len7 = WASM_VECTOR_LEN;
        const ptr8 = passStringToWasm0(data, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len8 = WASM_VECTOR_LEN;
        wasm.evm_sign_eip1559_transaction(retptr, ptr0, len0, ptr1, len1, chain_id, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred10_0 = r0;
        deferred10_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred10_0, deferred10_1, 1);
    }
}

/**
 * Unseal SA2 artifact to recover mnemonic
 * Returns mnemonic string, or "error:..." on failure
 * @param {string} sa2_base64
 * @param {string} password
 * @param {string} normalized_email
 * @returns {string}
 */
export function vadar_unseal_sa2(sa2_base64, password, normalized_email) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(sa2_base64, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(password, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(normalized_email, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        wasm.vadar_unseal_sa2(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Sign message - returns base64 signature on success, or "error:..." on failure
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {Uint8Array} message
 * @param {number} curve
 * @returns {string}
 */
export function acegf_sign_message_wasm(mnemonic, passphrase, message, curve) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(message, wasm.__wbindgen_export3);
        const len2 = WASM_VECTOR_LEN;
        wasm.acegf_sign_message_wasm(retptr, ptr0, len0, ptr1, len1, ptr2, len2, curve);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

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
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} message
 * @returns {string}
 */
export function evm_sign_personal_message(mnemonic, passphrase, message) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(message, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        wasm.evm_sign_personal_message(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Sign EVM EIP-1559 transaction with context isolation (passphrase path)
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} context
 * @param {bigint} chain_id
 * @param {string} nonce
 * @param {string} max_priority_fee_per_gas
 * @param {string} max_fee_per_gas
 * @param {string} gas_limit
 * @param {string} to
 * @param {string} value
 * @param {string} data
 * @returns {string}
 */
export function evm_sign_eip1559_transaction_with_context(mnemonic, passphrase, context, chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit, to, value, data) {
    let deferred11_0;
    let deferred11_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(context, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(nonce, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(max_priority_fee_per_gas, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(max_fee_per_gas, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passStringToWasm0(gas_limit, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passStringToWasm0(to, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len7 = WASM_VECTOR_LEN;
        const ptr8 = passStringToWasm0(value, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len8 = WASM_VECTOR_LEN;
        const ptr9 = passStringToWasm0(data, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len9 = WASM_VECTOR_LEN;
        wasm.evm_sign_eip1559_transaction_with_context(retptr, ptr0, len0, ptr1, len1, ptr2, len2, chain_id, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred11_0 = r0;
        deferred11_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred11_0, deferred11_1, 1);
    }
}

/**
 * Change passphrase for wallets created WITHOUT secondary (e.g. extension via generate_wasm).
 * Unseals with (existing_passphrase, None), seals with (new_passphrase, Some(admin_factor)).
 * Use this for extension wallets. Returns new mnemonic on success, None on failure.
 * @param {string} existing_mnemonic
 * @param {string} existing_passphrase
 * @param {string} new_passphrase
 * @param {string} admin_factor
 * @returns {string | undefined}
 */
export function acegf_change_passphrase_add_admin_wasm(existing_mnemonic, existing_passphrase, new_passphrase, admin_factor) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(existing_mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(existing_passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(new_passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(admin_factor, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        wasm.acegf_change_passphrase_add_admin_wasm(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        let v5;
        if (r0 !== 0) {
            v5 = getStringFromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
        }
        return v5;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * 签名外部序列化的交易 (Legacy Transaction)
 *
 * 参数:
 * - mnemonic: ACE-GF 助记词
 * - passphrase: 密码
 * - serialized_tx_base64: base64 编码的序列化交易
 *
 * 返回: base64 编码的签名交易，或者 "error:..." 错误信息
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} serialized_tx_base64
 * @returns {string}
 */
export function solana_sign_transaction(mnemonic, passphrase, serialized_tx_base64) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(serialized_tx_base64, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        wasm.solana_sign_transaction(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

/**
 * View wallet using PRF key (skips passphrase decryption in JS)
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @returns {any}
 */
export function view_wallet_with_prf_wasm(mnemonic, prf_key) {
    const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.view_wallet_with_prf_wasm(ptr0, len0, ptr1, len1);
    return takeObject(ret);
}

/**
 * @param {string} passphrase
 * @param {string | null} [secondary_passphrase]
 * @returns {any}
 */
export function generate_with_secondary_wasm(passphrase, secondary_passphrase) {
    const ptr0 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(secondary_passphrase) ? 0 : passStringToWasm0(secondary_passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    var len1 = WASM_VECTOR_LEN;
    const ret = wasm.generate_with_secondary_wasm(ptr0, len0, ptr1, len1);
    return takeObject(ret);
}

/**
 * XIdentity verify - returns "true", "false", or "error:..." on failure
 * @param {string} xidentity_b64
 * @param {Uint8Array} message
 * @param {Uint8Array} signature
 * @returns {string}
 */
export function acegf_xidentity_verify_wasm(xidentity_b64, message, signature) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(xidentity_b64, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(message, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(signature, wasm.__wbindgen_export3);
        const len2 = WASM_VECTOR_LEN;
        wasm.acegf_xidentity_verify_wasm(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

export function init_panic_hook() {
    wasm.init_panic_hook();
}

/**
 * @param {string} mnemonic
 * @param {string} passphrase
 * @returns {any}
 */
export function view_wallet_wasm(mnemonic, passphrase) {
    const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.view_wallet_wasm(ptr0, len0, ptr1, len1);
    return takeObject(ret);
}

/**
 * Get EVM address using PRF key
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @returns {string}
 */
export function evm_get_address_with_prf(mnemonic, prf_key) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        wasm.evm_get_address_with_prf(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred3_0 = r0;
        deferred3_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Sign EVM Legacy Transaction using PRF key
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @param {bigint} chain_id
 * @param {string} nonce
 * @param {string} gas_price
 * @param {string} gas_limit
 * @param {string} to
 * @param {string} value
 * @param {string} data
 * @returns {string}
 */
export function evm_sign_legacy_transaction_with_prf(mnemonic, prf_key, chain_id, nonce, gas_price, gas_limit, to, value, data) {
    let deferred9_0;
    let deferred9_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(nonce, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(gas_price, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(gas_limit, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(to, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passStringToWasm0(value, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passStringToWasm0(data, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len7 = WASM_VECTOR_LEN;
        wasm.evm_sign_legacy_transaction_with_prf(retptr, ptr0, len0, ptr1, len1, chain_id, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred9_0 = r0;
        deferred9_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred9_0, deferred9_1, 1);
    }
}

/**
 * Seal mnemonic into SA2 artifact
 * Returns base64-encoded SA2, or "error:..." on failure
 * @param {string} mnemonic
 * @param {string} password
 * @param {string} normalized_email
 * @returns {string}
 */
export function vadar_seal_sa2(mnemonic, password, normalized_email) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(password, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(normalized_email, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        wasm.vadar_seal_sa2(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Compute DH shared key using PRF key
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @param {string} peer_pub_b64
 * @returns {string}
 */
export function acegf_compute_dh_key_with_prf_wasm(mnemonic, prf_key, peer_pub_b64) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(peer_pub_b64, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        wasm.acegf_compute_dh_key_with_prf_wasm(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

/**
 * SPL Token 转账签名 (带创建目标 ATA)
 *
 * 当接收方的 ATA 不存在时使用此函数
 * 交易包含两个指令：createAssociatedTokenAccount + Transfer
 *
 * 参数:
 * - mnemonic: 助记词
 * - passphrase: 密码
 * - mint: SPL Token mint 地址 (base58)
 * - to_wallet: 接收方钱包地址 (base58，不是 ATA，函数内部会自动计算 ATA)
 * - amount: 转账数量 (raw amount，已经乘以 10^decimals)
 * - recent_blockhash: 最新区块哈希
 *
 * 返回: base64 编码的签名交易
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} mint
 * @param {string} to_wallet
 * @param {bigint} amount
 * @param {string} recent_blockhash
 * @returns {string}
 */
export function solana_sign_spl_transfer_with_create_ata(mnemonic, passphrase, mint, to_wallet, amount, recent_blockhash) {
    let deferred6_0;
    let deferred6_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(mint, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(to_wallet, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(recent_blockhash, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len4 = WASM_VECTOR_LEN;
        wasm.solana_sign_spl_transfer_with_create_ata(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, amount, ptr4, len4);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred6_0 = r0;
        deferred6_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred6_0, deferred6_1, 1);
    }
}

/**
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string | null} [secondary_passphrase]
 * @returns {any}
 */
export function view_wallet_unified_with_secondary_wasm(mnemonic, passphrase, secondary_passphrase) {
    const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len1 = WASM_VECTOR_LEN;
    var ptr2 = isLikeNone(secondary_passphrase) ? 0 : passStringToWasm0(secondary_passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    var len2 = WASM_VECTOR_LEN;
    const ret = wasm.view_wallet_unified_with_secondary_wasm(ptr0, len0, ptr1, len1, ptr2, len2);
    return takeObject(ret);
}

/**
 * @param {string} passphrase
 * @returns {any}
 */
export function generate_wasm(passphrase) {
    const ptr0 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.generate_wasm(ptr0, len0);
    return takeObject(ret);
}

/**
 * @param {string} mnemonic
 * @param {string} old_passphrase
 * @param {string} new_passphrase
 * @returns {string | undefined}
 */
export function acegf_change_passphrase_wasm(mnemonic, old_passphrase, new_passphrase) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(old_passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(new_passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        wasm.acegf_change_passphrase_wasm(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        let v4;
        if (r0 !== 0) {
            v4 = getStringFromWasm0(r0, r1).slice();
            wasm.__wbindgen_export2(r0, r1 * 1, 1);
        }
        return v4;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Generate scriptPubKey for any Bitcoin address
 *
 * Supports all address types:
 * - Bech32/Bech32m: bc1q... (P2WPKH), bc1p... (P2TR), tb1q..., tb1p...
 * - Legacy Base58Check: 1... (P2PKH), 3... (P2SH), m.../n... (testnet P2PKH), 2... (testnet P2SH)
 *
 * Returns: scriptPubKey as hex string, or "error:..." on failure
 * @param {string} address
 * @returns {string}
 */
export function bitcoin_address_to_script_pubkey(address) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(address, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        wasm.bitcoin_address_to_script_pubkey(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred2_0, deferred2_1, 1);
    }
}

/**
 * View wallet with context isolation (passphrase path)
 * Returns 7 chain addresses for the given context, or error for legacy wallets.
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} context
 * @returns {any}
 */
export function view_wallet_unified_with_context_wasm(mnemonic, passphrase, context) {
    const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(context, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.view_wallet_unified_with_context_wasm(ptr0, len0, ptr1, len1, ptr2, len2);
    return takeObject(ret);
}

/**
 * Get Solana address with context isolation (PRF path)
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @param {string} context
 * @returns {string}
 */
export function solana_get_address_with_context_prf(mnemonic, prf_key, context) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(context, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        wasm.solana_get_address_with_context_prf(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Compute Discovery ID from password and normalized email
 * Returns hex-encoded 32-byte discovery ID, or "error:..." on failure
 * @param {string} password
 * @param {string} normalized_email
 * @returns {string}
 */
export function vadar_compute_discovery_id(password, normalized_email) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(password, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(normalized_email, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        wasm.vadar_compute_discovery_id(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred3_0 = r0;
        deferred3_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Encrypt data for a recipient's xidentity public key
 * Returns JSON: { ephemeral_pub, encrypted_aes_key, iv, encrypted_data }
 * or "error:..." on failure
 * @param {string} recipient_xidentity_b64
 * @param {Uint8Array} plaintext
 * @returns {string}
 */
export function acegf_encrypt_for_xidentity(recipient_xidentity_b64, plaintext) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(recipient_xidentity_b64, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(plaintext, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        wasm.acegf_encrypt_for_xidentity(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred3_0 = r0;
        deferred3_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred3_0, deferred3_1, 1);
    }
}

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
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} typed_data_hash
 * @returns {string}
 */
export function evm_sign_typed_data(mnemonic, passphrase, typed_data_hash) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(typed_data_hash, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        wasm.evm_sign_typed_data(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Sign an arbitrary message with Solana context-derived Ed25519 key (PRF path)
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @param {string} context
 * @param {string} message
 * @returns {string}
 */
export function solana_sign_message_with_context_prf(mnemonic, prf_key, context, message) {
    let deferred5_0;
    let deferred5_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(context, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(message, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        wasm.solana_sign_message_with_context_prf(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred5_0 = r0;
        deferred5_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Sign registry update for create/update operations
 * Returns base64-encoded Ed25519 signature, or "error:..." on failure
 * @param {string} password
 * @param {string} normalized_email
 * @param {string} discovery_id
 * @param {string} cid
 * @param {bigint} version
 * @param {string} commit
 * @returns {string}
 */
export function vadar_sign_registry_update(password, normalized_email, discovery_id, cid, version, commit) {
    let deferred6_0;
    let deferred6_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(password, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(normalized_email, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(discovery_id, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(cid, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(commit, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len4 = WASM_VECTOR_LEN;
        wasm.vadar_sign_registry_update(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, version, ptr4, len4);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred6_0 = r0;
        deferred6_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred6_0, deferred6_1, 1);
    }
}

/**
 * Sign Solana external transaction using PRF key
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @param {string} serialized_tx_base64
 * @returns {string}
 */
export function solana_sign_transaction_with_prf(mnemonic, prf_key, serialized_tx_base64) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(serialized_tx_base64, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        wasm.solana_sign_transaction_with_prf(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Generate a new REV32 wallet with passphrase
 * Returns JSON: { mnemonic, solana_address, evm_address, bitcoin_address, cosmos_address, polkadot_address, xaddress, xidentity }
 * or JSON: { error: true, message: "..." }
 * @param {string} passphrase
 * @returns {any}
 */
export function generate_rev32_wasm(passphrase) {
    const ptr0 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.generate_rev32_wasm(ptr0, len0);
    return takeObject(ret);
}

/**
 * Sign a Solana serialized transaction with context isolation (PRF path)
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @param {string} context
 * @param {string} serialized_tx_base64
 * @returns {string}
 */
export function solana_sign_transaction_with_context_prf(mnemonic, prf_key, context, serialized_tx_base64) {
    let deferred5_0;
    let deferred5_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(context, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(serialized_tx_base64, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        wasm.solana_sign_transaction_with_context_prf(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred5_0 = r0;
        deferred5_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred5_0, deferred5_1, 1);
    }
}

/**
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string | null} [secondary_passphrase]
 * @returns {any}
 */
export function view_wallet_with_secondary_wasm(mnemonic, passphrase, secondary_passphrase) {
    const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len1 = WASM_VECTOR_LEN;
    var ptr2 = isLikeNone(secondary_passphrase) ? 0 : passStringToWasm0(secondary_passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    var len2 = WASM_VECTOR_LEN;
    const ret = wasm.view_wallet_with_secondary_wasm(ptr0, len0, ptr1, len1, ptr2, len2);
    return takeObject(ret);
}

/**
 * Sign message - returns signature bytes on success, or error string prefixed with "error:" on failure
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string | null | undefined} secondary_passphrase
 * @param {Uint8Array} message
 * @param {number} curve
 * @returns {string}
 */
export function acegf_sign_message_with_secondary_wasm(mnemonic, passphrase, secondary_passphrase, message, curve) {
    let deferred5_0;
    let deferred5_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        var ptr2 = isLikeNone(secondary_passphrase) ? 0 : passStringToWasm0(secondary_passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        var len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray8ToWasm0(message, wasm.__wbindgen_export3);
        const len3 = WASM_VECTOR_LEN;
        wasm.acegf_sign_message_with_secondary_wasm(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, curve);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred5_0 = r0;
        deferred5_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Compute DH shared key - returns base64-encoded key on success, or "error:..." on failure
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} peer_pub_b64
 * @returns {string}
 */
export function acegf_compute_dh_key_wasm(mnemonic, passphrase, peer_pub_b64) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(peer_pub_b64, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        wasm.acegf_compute_dh_key_wasm(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Sign an EIP-1559 Transaction with secondary passphrase (e.g. admin factor)
 *
 * Same as evm_sign_eip1559_transaction but combines passphrase with secondary_passphrase
 * for key derivation. This allows recipients holding 3-factor credentials
 * (mnemonic + passphrase + admin_factor) to sign as the wallet owner.
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string | null | undefined} secondary_passphrase
 * @param {bigint} chain_id
 * @param {string} nonce
 * @param {string} max_priority_fee_per_gas
 * @param {string} max_fee_per_gas
 * @param {string} gas_limit
 * @param {string} to
 * @param {string} value
 * @param {string} data
 * @returns {string}
 */
export function evm_sign_eip1559_transaction_with_secondary(mnemonic, passphrase, secondary_passphrase, chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit, to, value, data) {
    let deferred11_0;
    let deferred11_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        var ptr2 = isLikeNone(secondary_passphrase) ? 0 : passStringToWasm0(secondary_passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        var len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(nonce, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(max_priority_fee_per_gas, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(max_fee_per_gas, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passStringToWasm0(gas_limit, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passStringToWasm0(to, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len7 = WASM_VECTOR_LEN;
        const ptr8 = passStringToWasm0(value, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len8 = WASM_VECTOR_LEN;
        const ptr9 = passStringToWasm0(data, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len9 = WASM_VECTOR_LEN;
        wasm.evm_sign_eip1559_transaction_with_secondary(retptr, ptr0, len0, ptr1, len1, ptr2, len2, chain_id, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred11_0 = r0;
        deferred11_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred11_0, deferred11_1, 1);
    }
}

/**
 * Sign EVM personal message with context isolation (passphrase path)
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} context
 * @param {string} message
 * @returns {string}
 */
export function evm_sign_personal_message_with_context(mnemonic, passphrase, context, message) {
    let deferred5_0;
    let deferred5_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(context, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(message, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        wasm.evm_sign_personal_message_with_context(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred5_0 = r0;
        deferred5_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Get Solana address with context isolation (passphrase path)
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} context
 * @returns {string}
 */
export function solana_get_address_with_context(mnemonic, passphrase, context) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(context, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        wasm.solana_get_address_with_context(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Sign EVM EIP-1559 transaction with context isolation (PRF path)
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @param {string} context
 * @param {bigint} chain_id
 * @param {string} nonce
 * @param {string} max_priority_fee_per_gas
 * @param {string} max_fee_per_gas
 * @param {string} gas_limit
 * @param {string} to
 * @param {string} value
 * @param {string} data
 * @returns {string}
 */
export function evm_sign_eip1559_transaction_with_context_prf(mnemonic, prf_key, context, chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit, to, value, data) {
    let deferred11_0;
    let deferred11_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(context, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(nonce, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(max_priority_fee_per_gas, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(max_fee_per_gas, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passStringToWasm0(gas_limit, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passStringToWasm0(to, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len7 = WASM_VECTOR_LEN;
        const ptr8 = passStringToWasm0(value, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len8 = WASM_VECTOR_LEN;
        const ptr9 = passStringToWasm0(data, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len9 = WASM_VECTOR_LEN;
        wasm.evm_sign_eip1559_transaction_with_context_prf(retptr, ptr0, len0, ptr1, len1, ptr2, len2, chain_id, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred11_0 = r0;
        deferred11_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred11_0, deferred11_1, 1);
    }
}

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
 * @param {string} spender
 * @param {string} amount
 * @returns {string}
 */
export function evm_encode_erc20_approve(spender, amount) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(spender, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(amount, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        wasm.evm_encode_erc20_approve(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred3_0 = r0;
        deferred3_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred3_0, deferred3_1, 1);
    }
}

/**
 * SPL Token 转账签名
 *
 * 参数:
 * - mnemonic: 助记词
 * - passphrase: 密码
 * - mint: SPL Token mint 地址 (base58)
 * - to_wallet: 接收方钱包地址 (base58，不是 ATA，函数内部会自动计算 ATA)
 * - amount: 转账数量 (raw amount，已经乘以 10^decimals)
 * - recent_blockhash: 最新区块哈希
 *
 * 返回: base64 编码的签名交易
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} mint
 * @param {string} to_wallet
 * @param {bigint} amount
 * @param {string} recent_blockhash
 * @returns {string}
 */
export function solana_sign_spl_transfer(mnemonic, passphrase, mint, to_wallet, amount, recent_blockhash) {
    let deferred6_0;
    let deferred6_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(mint, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(to_wallet, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(recent_blockhash, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len4 = WASM_VECTOR_LEN;
        wasm.solana_sign_spl_transfer(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, amount, ptr4, len4);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred6_0 = r0;
        deferred6_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred6_0, deferred6_1, 1);
    }
}

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
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {bigint} chain_id
 * @param {string} nonce
 * @param {string} gas_price
 * @param {string} gas_limit
 * @param {string} to
 * @param {string} value
 * @param {string} data
 * @returns {string}
 */
export function evm_sign_legacy_transaction(mnemonic, passphrase, chain_id, nonce, gas_price, gas_limit, to, value, data) {
    let deferred9_0;
    let deferred9_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(nonce, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(gas_price, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(gas_limit, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(to, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passStringToWasm0(value, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passStringToWasm0(data, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len7 = WASM_VECTOR_LEN;
        wasm.evm_sign_legacy_transaction(retptr, ptr0, len0, ptr1, len1, chain_id, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred9_0 = r0;
        deferred9_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred9_0, deferred9_1, 1);
    }
}

/**
 * Sign a Bitcoin SegWit transaction using PRF key (no passphrase in JS)
 *
 * Parameters same as bitcoin_sign_transaction, but uses prf_key instead of passphrase.
 *
 * Returns: signed transaction as hex string, or "error:..." on failure
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @param {string} tx_json
 * @returns {string}
 */
export function bitcoin_sign_transaction_prf(mnemonic, prf_key, tx_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(tx_json, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        wasm.bitcoin_sign_transaction_prf(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Get EVM address with context isolation (passphrase path)
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} context
 * @returns {string}
 */
export function evm_get_address_with_context(mnemonic, passphrase, context) {
    let deferred4_0;
    let deferred4_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(context, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        wasm.evm_get_address_with_context(retptr, ptr0, len0, ptr1, len1, ptr2, len2);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred4_0 = r0;
        deferred4_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Generate a new REV32 wallet with passphrase and optional secondary passphrase
 * @param {string} passphrase
 * @param {string | null} [secondary_passphrase]
 * @returns {any}
 */
export function generate_rev32_with_secondary_wasm(passphrase, secondary_passphrase) {
    const ptr0 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(secondary_passphrase) ? 0 : passStringToWasm0(secondary_passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    var len1 = WASM_VECTOR_LEN;
    const ret = wasm.generate_rev32_with_secondary_wasm(ptr0, len0, ptr1, len1);
    return takeObject(ret);
}

/**
 * Unified wallet view - auto-detects UUID vs REV32 format
 * Works with both 18-word (legacy UUID) and 24-word (REV32) mnemonics
 * @param {string} mnemonic
 * @param {string} passphrase
 * @returns {any}
 */
export function view_wallet_unified_wasm(mnemonic, passphrase) {
    const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.view_wallet_unified_wasm(ptr0, len0, ptr1, len1);
    return takeObject(ret);
}

/**
 * View wallet with context isolation (PRF path)
 * Uses PRF key → base_key → identity_root → context-isolated seeds
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @param {string} context
 * @returns {any}
 */
export function view_wallet_with_context_prf_wasm(mnemonic, prf_key, context) {
    const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(context, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.view_wallet_with_context_prf_wasm(ptr0, len0, ptr1, len1, ptr2, len2);
    return takeObject(ret);
}

/**
 * @param {string} mnemonic
 * @param {string} passphrase
 * @param {string} to_pubkey
 * @param {bigint} lamports
 * @param {string} recent_blockhash
 * @returns {string}
 */
export function solana_sign_system_transfer(mnemonic, passphrase, to_pubkey, lamports, recent_blockhash) {
    let deferred5_0;
    let deferred5_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(to_pubkey, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(recent_blockhash, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        wasm.solana_sign_system_transfer(retptr, ptr0, len0, ptr1, len1, ptr2, len2, lamports, ptr3, len3);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred5_0 = r0;
        deferred5_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Sign EVM typed data with context isolation (PRF path)
 * @param {string} mnemonic
 * @param {Uint8Array} prf_key
 * @param {string} context
 * @param {string} typed_data_hash
 * @returns {string}
 */
export function evm_sign_typed_data_with_context_prf(mnemonic, prf_key, context, typed_data_hash) {
    let deferred5_0;
    let deferred5_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(prf_key, wasm.__wbindgen_export3);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(context, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(typed_data_hash, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len3 = WASM_VECTOR_LEN;
        wasm.evm_sign_typed_data_with_context_prf(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred5_0 = r0;
        deferred5_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export2(deferred5_0, deferred5_1, 1);
    }
}

const EXPECTED_RESPONSE_TYPES = new Set(['basic', 'cors', 'default']);

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbg___wbindgen_is_function_ee8a6c5833c90377 = function(arg0) {
        const ret = typeof(getObject(arg0)) === 'function';
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_object_c818261d21f283a4 = function(arg0) {
        const val = getObject(arg0);
        const ret = typeof(val) === 'object' && val !== null;
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_string_fbb76cb2940daafd = function(arg0) {
        const ret = typeof(getObject(arg0)) === 'string';
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_undefined_2d472862bd29a478 = function(arg0) {
        const ret = getObject(arg0) === undefined;
        return ret;
    };
    imports.wbg.__wbg___wbindgen_throw_b855445ff6a94295 = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };
    imports.wbg.__wbg_call_525440f72fbfc0ea = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = getObject(arg0).call(getObject(arg1), getObject(arg2));
        return addHeapObject(ret);
    }, arguments) };
    imports.wbg.__wbg_call_e762c39fa8ea36bf = function() { return handleError(function (arg0, arg1) {
        const ret = getObject(arg0).call(getObject(arg1));
        return addHeapObject(ret);
    }, arguments) };
    imports.wbg.__wbg_crypto_574e78ad8b13b65f = function(arg0) {
        const ret = getObject(arg0).crypto;
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_error_7534b8e9a36f1ab4 = function(arg0, arg1) {
        let deferred0_0;
        let deferred0_1;
        try {
            deferred0_0 = arg0;
            deferred0_1 = arg1;
            console.error(getStringFromWasm0(arg0, arg1));
        } finally {
            wasm.__wbindgen_export2(deferred0_0, deferred0_1, 1);
        }
    };
    imports.wbg.__wbg_getRandomValues_38a1ff1ea09f6cc7 = function() { return handleError(function (arg0, arg1) {
        globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
    }, arguments) };
    imports.wbg.__wbg_getRandomValues_b8f5dbd5f3995a9e = function() { return handleError(function (arg0, arg1) {
        getObject(arg0).getRandomValues(getObject(arg1));
    }, arguments) };
    imports.wbg.__wbg_length_69bca3cb64fc8748 = function(arg0) {
        const ret = getObject(arg0).length;
        return ret;
    };
    imports.wbg.__wbg_msCrypto_a61aeb35a24c1329 = function(arg0) {
        const ret = getObject(arg0).msCrypto;
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_new_8a6f238a6ece86ea = function() {
        const ret = new Error();
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_new_no_args_ee98eee5275000a4 = function(arg0, arg1) {
        const ret = new Function(getStringFromWasm0(arg0, arg1));
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_new_with_length_01aa0dc35aa13543 = function(arg0) {
        const ret = new Uint8Array(arg0 >>> 0);
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_node_905d3e251edff8a2 = function(arg0) {
        const ret = getObject(arg0).node;
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_parse_41503dcdc1dc43f2 = function(arg0, arg1) {
        let deferred0_0;
        let deferred0_1;
        try {
            deferred0_0 = arg0;
            deferred0_1 = arg1;
            const ret = JSON.parse(getStringFromWasm0(arg0, arg1));
            return addHeapObject(ret);
        } finally {
            wasm.__wbindgen_export2(deferred0_0, deferred0_1, 1);
        }
    };
    imports.wbg.__wbg_process_dc0fbacc7c1c06f7 = function(arg0) {
        const ret = getObject(arg0).process;
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_prototypesetcall_2a6620b6922694b2 = function(arg0, arg1, arg2) {
        Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), getObject(arg2));
    };
    imports.wbg.__wbg_randomFillSync_ac0988aba3254290 = function() { return handleError(function (arg0, arg1) {
        getObject(arg0).randomFillSync(takeObject(arg1));
    }, arguments) };
    imports.wbg.__wbg_require_60cc747a6bc5215a = function() { return handleError(function () {
        const ret = module.require;
        return addHeapObject(ret);
    }, arguments) };
    imports.wbg.__wbg_stack_0ed75d68575b0f3c = function(arg0, arg1) {
        const ret = getObject(arg1).stack;
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export3, wasm.__wbindgen_export4);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_89e1d9ac6a1b250e = function() {
        const ret = typeof global === 'undefined' ? null : global;
        return isLikeNone(ret) ? 0 : addHeapObject(ret);
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_THIS_8b530f326a9e48ac = function() {
        const ret = typeof globalThis === 'undefined' ? null : globalThis;
        return isLikeNone(ret) ? 0 : addHeapObject(ret);
    };
    imports.wbg.__wbg_static_accessor_SELF_6fdf4b64710cc91b = function() {
        const ret = typeof self === 'undefined' ? null : self;
        return isLikeNone(ret) ? 0 : addHeapObject(ret);
    };
    imports.wbg.__wbg_static_accessor_WINDOW_b45bfc5a37f6cfa2 = function() {
        const ret = typeof window === 'undefined' ? null : window;
        return isLikeNone(ret) ? 0 : addHeapObject(ret);
    };
    imports.wbg.__wbg_subarray_480600f3d6a9f26c = function(arg0, arg1, arg2) {
        const ret = getObject(arg0).subarray(arg1 >>> 0, arg2 >>> 0);
        return addHeapObject(ret);
    };
    imports.wbg.__wbg_versions_c01dfd4722a88165 = function(arg0) {
        const ret = getObject(arg0).versions;
        return addHeapObject(ret);
    };
    imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
        // Cast intrinsic for `Ref(String) -> Externref`.
        const ret = getStringFromWasm0(arg0, arg1);
        return addHeapObject(ret);
    };
    imports.wbg.__wbindgen_cast_cb9088102bce6b30 = function(arg0, arg1) {
        // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
        const ret = getArrayU8FromWasm0(arg0, arg1);
        return addHeapObject(ret);
    };
    imports.wbg.__wbindgen_object_clone_ref = function(arg0) {
        const ret = getObject(arg0);
        return addHeapObject(ret);
    };
    imports.wbg.__wbindgen_object_drop_ref = function(arg0) {
        takeObject(arg0);
    };

    return imports;
}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('acegf_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
