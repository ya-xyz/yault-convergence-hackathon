/**
 * Attestation gate policy for release decisions.
 *
 * When oracle is configured: release requires a valid on-chain oracle attestation.
 * When oracle is not configured: gate is not applied (pass-through), so entity-authority-only
 * or non-oracle deployments can still release.
 */
'use strict';

const config = require('../config');
const { getAttestation } = require('./attestationClient');

const DEFAULT_MAX_AGE_SEC = 7 * 24 * 60 * 60; // 7 days
const ATTESTATION_MAX_AGE_MS =
  Math.max(1, parseInt(process.env.ATTESTATION_MAX_AGE_SEC || `${DEFAULT_MAX_AGE_SEC}`, 10)) * 1000;

/**
 * Evaluate whether a release is allowed by current on-chain attestation.
 *
 * @param {{ walletId: string, recipientIndex: number }} input
 * @returns {Promise<{ valid: boolean, code: string|null, detail: string|null, attestation: any }>}
 */
async function evaluateReleaseAttestationGate(input) {
  const walletId = String(input && input.walletId ? input.walletId : '').trim();
  const recipientIndex = Number(input && input.recipientIndex);
  if (!walletId || !Number.isInteger(recipientIndex) || recipientIndex < 0) {
    return {
      valid: false,
      code: 'ATTESTATION_INVALID_INPUT',
      detail: 'walletId and recipientIndex are required',
      attestation: null,
    };
  }

  const oracleEnabled =
    config.oracle &&
    config.oracle.enabled &&
    config.oracle.releaseAttestationAddress &&
    config.oracle.rpcUrl;
  if (!oracleEnabled) {
    // Gate not applicable: allow release (entity-authority-only or non-oracle deployments).
    return {
      valid: true,
      code: null,
      detail: null,
      attestation: null,
    };
  }

  let attestation = null;
  try {
    attestation = await getAttestation({
      rpcUrl: config.oracle.rpcUrl,
      contractAddress: config.oracle.releaseAttestationAddress,
      walletId,
      recipientIndex,
      throwOnError: true,
    });
  } catch (err) {
    return {
      valid: false,
      code: 'ATTESTATION_RPC_ERROR',
      detail: err && err.message ? err.message : 'Failed to read attestation',
      attestation: null,
    };
  }

  if (!attestation) {
    return {
      valid: false,
      code: 'ATTESTATION_MISSING',
      detail: 'No attestation found for this wallet and recipient path',
      attestation: null,
    };
  }
  if (attestation.source !== 'oracle') {
    return {
      valid: false,
      code: 'ATTESTATION_SOURCE_INVALID',
      detail: `Attestation source "${attestation.source}" is not accepted`,
      attestation,
    };
  }
  if (attestation.decision !== 'release') {
    return {
      valid: false,
      code: 'ATTESTATION_DECISION_MISMATCH',
      detail: `Attestation decision "${attestation.decision}" is not release`,
      attestation,
    };
  }

  const ts = Number(attestation.timestamp || 0);
  if (Number.isFinite(ts) && ts > 0) {
    const ageMs = Date.now() - ts * 1000;
    if (ageMs > ATTESTATION_MAX_AGE_MS) {
      return {
        valid: false,
        code: 'ATTESTATION_EXPIRED',
        detail: `Attestation is older than ${Math.floor(ATTESTATION_MAX_AGE_MS / 1000)} seconds`,
        attestation,
      };
    }
  }

  return {
    valid: true,
    code: null,
    detail: null,
    attestation,
  };
}

module.exports = {
  evaluateReleaseAttestationGate,
  ATTESTATION_MAX_AGE_MS,
};
