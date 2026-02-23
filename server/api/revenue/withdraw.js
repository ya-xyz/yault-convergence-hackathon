/**
 * POST /api/revenue/withdraw
 *
 * Authority prepares an on-chain claim of accumulated revenue.
 * When VAULT_ADDRESS is set, returns a transaction payload for the authority
 * to sign and send (claimAuthorityRevenue()). Otherwise returns 501.
 *
 * Body: optional (authority is the authenticated wallet)
 * Returns: { status, transaction?, pending?, message }
 */

'use strict';

const { Router } = require('express');
const { authMiddleware } = require('../../middleware/auth');
const config = require('../../config');
const vaultContract = require('../../services/vaultContract');

const router = Router();

const hasVaultContract = () => !!(config.contracts && config.contracts.vaultAddress);

router.post('/', authMiddleware, async (req, res) => {
  const authorityAddress = (req.auth && req.auth.pubkey) ? req.auth.pubkey.replace(/^0x/i, '') : null;
  if (!authorityAddress) {
    return res.status(401).json({
      error: 'Unauthorized',
      detail: 'Wallet identity required to prepare revenue claim.',
    });
  }

  if (!hasVaultContract()) {
    return res.status(501).json({
      error: 'Withdrawals not configured',
      detail: 'Set VAULT_ADDRESS and EVM_RPC_URL in config for on-chain revenue claim.',
    });
  }

  const pending = await vaultContract.getPendingRevenue(config, '0x' + authorityAddress);
  const pendingNum = parseFloat(pending || '0');
  if (pendingNum <= 0) {
    return res.json({
      status: 'nothing_to_claim',
      pending: pending || '0',
      message: 'No pending revenue to claim.',
    });
  }

  const tx = await vaultContract.buildClaimAuthorityRevenueTx(config);
  if (!tx) {
    return res.status(503).json({
      error: 'Failed to build claim transaction',
      detail: 'Vault RPC or config may be invalid.',
    });
  }

  return res.json({
    status: 'pending_signature',
    transaction: tx,
    pending: pending,
    message: 'Sign and send this transaction in your wallet to claim your authority revenue.',
  });
});

module.exports = router;
