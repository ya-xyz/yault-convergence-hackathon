#!/usr/bin/env node
try { require('dotenv').config(); } catch (_) {}
const c = require('../server/config');

const vault = !!c.contracts.vaultAddress;
const oracle = !!c.oracle.releaseAttestationAddress && c.oracle.enabled;
const pathClaim = !!c.pathClaim.address;

console.log('=== Contract Config Check ===');
console.log('1. Vault (VAULT_ADDRESS):', vault ? 'configured' : 'not configured');
console.log('   EVM_RPC_URL:', c.contracts.evmRpcUrl ? 'configured' : 'not configured');
console.log('   VAULT_CHAIN_ID:', c.contracts.vaultChainId);
console.log('2. Oracle (ReleaseAttestation):', oracle ? 'configured and enabled' : (c.oracle.releaseAttestationAddress ? 'configured but disabled (ORACLE_ATTESTATION_ENABLED)' : 'not configured'));
console.log('3. PathClaim (PATH_CLAIM_ADDRESS):', pathClaim ? 'configured' : 'not configured');
console.log('   PATH_CLAIM_ASSET_ADDRESS:', c.pathClaim.assetAddress ? 'configured' : 'not configured');
console.log('');
console.log('Configured contracts:', [vault, oracle, pathClaim].filter(Boolean).length, '/ 3');
