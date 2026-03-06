/**
 * ReleaseAttestation contract — submit fallback attestations (platform/relayer).
 * The relayer wallet must be whitelisted on the contract via setFallbackSubmitter(relayer, true).
 */

'use strict';

const { ethers } = require('ethers');
const { walletIdHash } = require('./attestationClient');

const SUBMIT_ABI = [
  'function submitAttestation(uint8 source, bytes32 walletIdHash, uint256 recipientIndex, uint8 decision, bytes32 reasonCode, bytes32 evidenceHash) external',
];

const SOURCE_ORACLE = 0;
const SOURCE_FALLBACK = 1;
const DECISION_RELEASE = 0;
const DECISION_HOLD = 1;
const DECISION_REJECT = 2;

/** Map platform decision string to contract uint8 */
function decisionToUint8(decision) {
  if (decision === 'release') return DECISION_RELEASE;
  if (decision === 'hold') return DECISION_HOLD;
  if (decision === 'reject') return DECISION_REJECT;
  return DECISION_REJECT;
}

/** Hex string to bytes32 (pad or slice) */
function toBytes32(hex) {
  if (!hex || hex === '0x' || hex === '0x0') return ethers.ZeroHash;
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length >= 64) return '0x' + h.slice(0, 64).padStart(64, '0');
  return '0x' + h.padStart(64, '0');
}

/**
 * Submit a fallback attestation to the ReleaseAttestation contract.
 * @param {object} config - server config (oracle.releaseAttestationAddress, oracle.rpcUrl, oracle.releaseAttestationRelayerPrivateKey)
 * @param {object} params
 * @param {string} params.walletId - wallet_id (pseudonymous)
 * @param {number} params.recipientIndex - recipient path index (1-based to match platform)
 * @param {string} params.decision - 'release' | 'hold' | 'reject'
 * @param {string} [params.reasonCode] - optional hex bytes32 (e.g. keccak256 of "verified_death"))
 * @param {string} params.evidenceHash - hex bytes32 (e.g. SHA-256 of evidence bundle)
 * @param {string} [params.planId] - plan_id for multi-plan scoping
 * @returns {Promise<{ txHash: string }>}
 */
async function submitFallbackAttestation(config, params) {
  const { walletId, recipientIndex, decision, reasonCode, evidenceHash, planId } = params;
  const contractAddress = config?.oracle?.releaseAttestationAddress;
  const rpcUrl = config?.oracle?.rpcUrl;
  const relayerKey = config?.oracle?.releaseAttestationRelayerPrivateKey;

  if (!contractAddress || !relayerKey || !relayerKey.trim()) {
    throw new Error('ReleaseAttestation contract and RELEASE_ATTESTATION_RELAYER_PRIVATE_KEY must be set');
  }
  if (!walletId || recipientIndex == null) {
    throw new Error('walletId and recipientIndex are required');
  }
  if (!evidenceHash || typeof evidenceHash !== 'string') {
    throw new Error('evidenceHash (bytes32 hex) is required');
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl || 'https://eth.llamarpc.com');
  const wallet = new ethers.Wallet(relayerKey.trim(), provider);
  const contract = new ethers.Contract(contractAddress, SUBMIT_ABI, wallet);

  const hash = walletIdHash(walletId, planId);
  const decisionU8 = decisionToUint8(decision);
  const reasonBytes = toBytes32(reasonCode || '0');
  const evidenceBytes = toBytes32(evidenceHash);

  const tx = await contract.submitAttestation(
    SOURCE_FALLBACK,
    hash,
    recipientIndex,
    decisionU8,
    reasonBytes,
    evidenceBytes
  );
  const receipt = await tx.wait();
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

/**
 * Submit an oracle-source attestation (used by simulate-chainlink to mimic Chainlink CRE).
 * Same as submitFallbackAttestation but with source=0 (oracle).
 */
async function submitOracleAttestation(config, params) {
  const { walletId, recipientIndex, decision, reasonCode, evidenceHash, planId } = params;
  const contractAddress = config?.oracle?.releaseAttestationAddress;
  const rpcUrl = config?.oracle?.rpcUrl;
  const relayerKey = config?.oracle?.releaseAttestationRelayerPrivateKey;

  if (!contractAddress || !relayerKey || !relayerKey.trim()) {
    throw new Error('ReleaseAttestation contract and RELEASE_ATTESTATION_RELAYER_PRIVATE_KEY must be set');
  }
  if (!walletId || recipientIndex == null) {
    throw new Error('walletId and recipientIndex are required');
  }
  if (!evidenceHash || typeof evidenceHash !== 'string') {
    throw new Error('evidenceHash (bytes32 hex) is required');
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl || 'https://eth.llamarpc.com');
  const wallet = new ethers.Wallet(relayerKey.trim(), provider);
  const contract = new ethers.Contract(contractAddress, SUBMIT_ABI, wallet);

  const hash = walletIdHash(walletId, planId);
  const decisionU8 = decisionToUint8(decision);
  const reasonBytes = toBytes32(reasonCode || '0');
  const evidenceBytes = toBytes32(evidenceHash);

  const tx = await contract.submitAttestation(
    SOURCE_ORACLE,
    hash,
    recipientIndex,
    decisionU8,
    reasonBytes,
    evidenceBytes
  );
  const receipt = await tx.wait();
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

module.exports = {
  submitFallbackAttestation,
  submitOracleAttestation,
};
