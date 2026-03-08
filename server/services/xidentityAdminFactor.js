'use strict';

let encryptorPromise = null;

// @yallet/rwa-sdk uses Web Crypto global; ensure it's available in Node runtime.
if (!globalThis.crypto) {
  try {
    const nodeCrypto = require('crypto');
    if (nodeCrypto && nodeCrypto.webcrypto) {
      globalThis.crypto = nodeCrypto.webcrypto;
    }
  } catch (_) {}
}

function normalizeAdminFactorHex(value) {
  const hex = String(value || '').trim().toLowerCase().replace(/^0x/i, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('admin_factor must be a 64-char hex string');
  }
  return hex;
}

async function getEncryptor() {
  if (!encryptorPromise) {
    encryptorPromise = import('@yallet/rwa-sdk').then((mod) => {
      const Ctor = mod.ECIESEncryptor;
      if (!Ctor) throw new Error('ECIESEncryptor not available from @yallet/rwa-sdk');
      return new Ctor();
    }).catch((err) => {
      // Clear cached promise on failure so subsequent calls can retry
      encryptorPromise = null;
      throw err;
    });
  }
  return encryptorPromise;
}

async function encryptAdminFactorForXidentity(adminFactorHex, recipientXidentity) {
  const xidentity = String(recipientXidentity || '').trim();
  if (!xidentity) {
    throw new Error('recipient xidentity is required');
  }
  const normalizedHex = normalizeAdminFactorHex(adminFactorHex);
  const plaintext = new TextEncoder().encode(normalizedHex);
  const encryptor = await getEncryptor();
  return encryptor.encrypt(xidentity, plaintext);
}

module.exports = {
  encryptAdminFactorForXidentity,
  normalizeAdminFactorHex,
};
