/**
 * Shared AES-256-GCM encryption/decryption for admin_factor_hex at rest.
 *
 * Used by:
 * - release-factors.js (encrypt on write)
 * - wallet-plan.js (encrypt on write)
 * - lookup.js (decrypt on read)
 *
 * Key priority:
 * 1. ADMIN_FACTOR_ENCRYPTION_KEY (dedicated, recommended)
 * 2. CLIENT_SESSION_SECRET (fallback for dev/staging)
 * 3. None → plaintext fallback with critical error log
 */

'use strict';

const crypto = require('crypto');

const DEDICATED_KEY = process.env.ADMIN_FACTOR_ENCRYPTION_KEY;
const FALLBACK_KEY = process.env.CLIENT_SESSION_SECRET;

if (!DEDICATED_KEY && process.env.NODE_ENV !== 'test') {
  if (FALLBACK_KEY) {
    console.warn('[SECURITY] ADMIN_FACTOR_ENCRYPTION_KEY is not set. Falling back to CLIENT_SESSION_SECRET. Set a dedicated key for production.');
  } else if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
    throw new Error('[SECURITY CRITICAL] ADMIN_FACTOR_ENCRYPTION_KEY (or CLIENT_SESSION_SECRET) must be set in production/staging. Refusing to start with plaintext admin factor storage.');
  } else {
    console.error('[SECURITY CRITICAL] No encryption key configured. Admin factors will be stored in PLAINTEXT. Set ADMIN_FACTOR_ENCRYPTION_KEY immediately.');
  }
}

const EFFECTIVE_KEY = DEDICATED_KEY || FALLBACK_KEY || null;

/**
 * Encrypt an admin_factor hex string for at-rest storage.
 * Returns "iv:ciphertext:tag" format, or plaintext if no key is configured.
 */
function encryptAdminFactor(hex) {
  if (!EFFECTIVE_KEY) return hex;
  const key = crypto.createHash('sha256').update(EFFECTIVE_KEY).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(hex, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + encrypted.toString('hex') + ':' + tag.toString('hex');
}

/**
 * Decrypt an admin_factor stored as "iv:ciphertext:tag".
 * Returns plaintext hex on success, or the original value if decryption
 * fails (e.g. legacy unencrypted data or missing key).
 */
function decryptAdminFactor(stored) {
  if (!EFFECTIVE_KEY || !stored || !stored.includes(':')) return stored;
  try {
    const [ivHex, encHex, tagHex] = stored.split(':');
    const key = crypto.createHash('sha256').update(EFFECTIVE_KEY).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex'), null, 'utf8') + decipher.final('utf8');
  } catch (err) {
    // If the stored value looks like encrypted format (has colons) but fails to decrypt,
    // this indicates key mismatch or corruption — not legacy plaintext data.
    const parts = stored.split(':');
    if (parts.length === 3 && parts[0].length === 24 && parts[2].length === 32) {
      throw new Error('Admin factor decryption failed — possible key mismatch or data corruption');
    }
    // Likely legacy unencrypted data — return as-is for backward compatibility.
    return stored;
  }
}

module.exports = {
  encryptAdminFactor,
  decryptAdminFactor,
};
