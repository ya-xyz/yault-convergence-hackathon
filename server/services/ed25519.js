'use strict';

const nacl = require('tweetnacl');

/**
 * Verify an Ed25519 detached signature.
 * @param {string} message  - The message that was signed (utf-8 string).
 * @param {string} signature - Hex-encoded 64-byte Ed25519 signature.
 * @param {string} pubkey    - Hex-encoded 32-byte Ed25519 public key.
 * @returns {boolean} True if the signature is valid.
 */
function verify(message, signature, pubkey) {
  const messageBytes = new TextEncoder().encode(message);
  const signatureBytes = Buffer.from(signature, 'hex');
  const pubkeyBytes = Buffer.from(pubkey, 'hex');

  if (signatureBytes.length !== 64 || pubkeyBytes.length !== 32) {
    return false;
  }

  return nacl.sign.detached.verify(messageBytes, signatureBytes, pubkeyBytes);
}

module.exports = { verify };
