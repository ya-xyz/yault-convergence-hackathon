/**
 * ReleaseAttestation contract client — read chain for oracle/fallback attestations.
 * Used to implement "oracle first, entity authority fallback".
 *
 * Chainlink CRE workflow writes oracle attestations; fallback addresses write fallback attestations.
 * This module only reads; fallback writes are done by the platform (or relayer) via contract call.
 */

'use strict';

const { ethers } = require('ethers');

// #SUGGESTION: Update ABI to reflect the struct return type for getAttestation.
const RELEASE_ATTESTATION_ABI = [
  "function getAttestation(bytes32 walletIdHash, uint256 recipientIndex) view returns (tuple(uint8 source, uint8 decision, bytes32 reasonCode, bytes32 evidenceHash, uint64 timestamp, address submitter))",
  'function hasAttestation(bytes32 walletIdHash, uint256 recipientIndex) view returns (bool)',
];

const SOURCE_ORACLE = 0;
const SOURCE_FALLBACK = 1;
const DECISION_RELEASE = 0;
const DECISION_HOLD = 1;
const DECISION_REJECT = 2;

/**
 * Compute walletIdHash for the ReleaseAttestation contract.
 * When planId is provided: hash = keccak256(walletId + ":" + planId)
 *   so each plan gets an independent attestation namespace on-chain.
 * When planId is absent: hash = keccak256(walletId)
 *   for legacy / non-plan-scoped queries.
 * @param {string} walletId
 * @param {string} [planId] - plan identifier (optional for reads, required for writes)
 * @returns {string} 0x-prefixed hex bytes32
 */
function walletIdHash(walletId, planId) {
  const preimage = planId ? `${walletId}:${planId}` : walletId;
  return ethers.keccak256(ethers.toUtf8Bytes(preimage));
}

/**
 * Get attestation from chain for (wallet_id, recipient_index), optionally scoped by plan_id.
 * @param {object} options
 * @param {string} options.rpcUrl - EVM RPC URL
 * @param {string} options.contractAddress - ReleaseAttestation contract address
 * @param {string} options.walletId - wallet_id (pseudonymous)
 * @param {number} options.recipientIndex - recipient path index
 * @param {string} [options.planId] - plan_id for multi-plan scoping
 * @param {boolean} [options.throwOnError=false] - Throw RPC/contract read errors instead of returning null.
 * @returns {Promise<{ source: 'oracle'|'fallback', decision: 'release'|'hold'|'reject', reasonCode: string, evidenceHash: string, timestamp: number, submitter: string } | null>}
 */
async function getAttestation({ rpcUrl, contractAddress, walletId, recipientIndex, planId, throwOnError = false }) {
  if (!contractAddress || typeof contractAddress !== 'string') return null;
  try {
    if (ethers.getAddress(contractAddress) === ethers.ZeroAddress) return null;
  } catch (_) {
    return null; // invalid address format
  }
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(contractAddress, RELEASE_ATTESTATION_ABI, provider);
    const hash = walletIdHash(walletId, planId);

    // #SUGGESTION: Call the contract and destructure the returned struct.
    const attestation = await contract.getAttestation(hash, recipientIndex);

    const ts = typeof attestation.timestamp === 'bigint' ? Number(attestation.timestamp) : attestation.timestamp;
    if (ts === 0) return null;

    const src = typeof attestation.source === 'bigint' ? Number(attestation.source) : attestation.source;
    const dec = typeof attestation.decision === 'bigint' ? Number(attestation.decision) : attestation.decision;

    return {
      source: src === SOURCE_ORACLE ? 'oracle' : 'fallback',
      decision: dec === DECISION_RELEASE ? 'release' : dec === DECISION_HOLD ? 'hold' : 'reject',
      reasonCode: typeof attestation.reasonCode === 'string' ? attestation.reasonCode : ethers.hexlify(attestation.reasonCode),
      evidenceHash: typeof attestation.evidenceHash === 'string' ? attestation.evidenceHash : ethers.hexlify(attestation.evidenceHash),
      timestamp: ts,
      submitter: attestation.submitter,
    };
  } catch (err) {
    console.error('[attestationClient] getAttestation error:', err.message);
    if (throwOnError) throw err;
    return null;
  }
}

/**
 * Check if an attestation exists (any source).
 */
async function hasAttestation({ rpcUrl, contractAddress, walletId, recipientIndex, planId }) {
  if (!contractAddress || typeof contractAddress !== 'string') return false;
  try {
    if (ethers.getAddress(contractAddress) === ethers.ZeroAddress) return false;
  } catch (_) {
    return false;
  }
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(contractAddress, RELEASE_ATTESTATION_ABI, provider);
    const hash = walletIdHash(walletId, planId);
    return await contract.hasAttestation(hash, recipientIndex);
  } catch (err) {
    console.error('[attestationClient] hasAttestation error:', err.message);
    return false;
  }
}

module.exports = {
  walletIdHash,
  getAttestation,
  hasAttestation,
  SOURCE_ORACLE,
  SOURCE_FALLBACK,
  DECISION_RELEASE,
  DECISION_HOLD,
  DECISION_REJECT,
};
