/**
 * server/middleware/multisig.js — Multi-signature approval middleware for admin operations
 *
 * Implements M-of-N approval for sensitive admin actions. When a protected endpoint
 * is called, the first admin signer creates an approval request; subsequent signers
 * approve it; once the threshold is met the operation executes automatically.
 *
 * Usage:
 *   router.post('/trigger/emergency-release', requireMultisig('emergency-release'), handler);
 *
 * Flow:
 *   1. Admin A calls endpoint (no approval_id in body) → creates pending approval, returns 202
 *   2. Admin B calls endpoint with { approval_id } → adds signature, if threshold met → next()
 *   3. Handler executes with original params from step 1
 *
 * Approval records are persisted in db.adminApprovals for audit trail.
 */

'use strict';

const crypto = require('crypto');
const db = require('../db');

// ---------------------------------------------------------------------------
// Policy: which actions need how many approvals, and for how long
// ---------------------------------------------------------------------------

const MULTISIG_POLICY = {
  // Critical operations: 2-of-N, 1 hour expiry
  'emergency-release':     { required: 2, expiry_ms: 60 * 60 * 1000 },
  'trigger-abort':         { required: 2, expiry_ms: 60 * 60 * 1000 },
  'trigger-resume':        { required: 2, expiry_ms: 60 * 60 * 1000 },
  'trigger-legal-confirm': { required: 2, expiry_ms: 60 * 60 * 1000 },

  // Sensitive operations: 2-of-N, 4 hour expiry
  'kyc-review':            { required: 2, expiry_ms: 4 * 60 * 60 * 1000 },
  'user-role-change':      { required: 2, expiry_ms: 4 * 60 * 60 * 1000 },
  'authority-verify':      { required: 2, expiry_ms: 4 * 60 * 60 * 1000 },
  'force-redeliver':       { required: 2, expiry_ms: 4 * 60 * 60 * 1000 },
};

// Allow override via env: MULTISIG_DISABLED=true skips all checks (dev/test only)
function isMultisigDisabled() {
  // Multi-sig is always disabled in test environment to allow integration tests
  if (process.env.NODE_ENV === 'test') return true;
  return process.env.MULTISIG_DISABLED === 'true' && process.env.NODE_ENV === 'development';
}

// Allow override of required count per action: MULTISIG_REQUIRED_emergency-release=3
function getRequiredCount(action) {
  const envKey = `MULTISIG_REQUIRED_${action}`;
  const envVal = process.env[envKey];
  if (envVal && !isNaN(parseInt(envVal, 10))) {
    return Math.max(1, parseInt(envVal, 10));
  }
  return MULTISIG_POLICY[action]?.required || 2;
}

// ---------------------------------------------------------------------------
// Notification hook (extensible: email, Slack, webhook)
// ---------------------------------------------------------------------------

async function notifyAdmins(action, approvalId, initiatorAddress) {
  // Log for now; integrators can replace with email/Slack/webhook
  console.log(
    '[multisig] Approval request created: action=%s approval_id=%s initiator=%s',
    action, approvalId, initiatorAddress || 'unknown'
  );
  // Future: send email to all ADMIN_WALLETS holders, post to Slack channel, etc.
}

// ---------------------------------------------------------------------------
// Expiry cleanup: prune expired approvals periodically
// ---------------------------------------------------------------------------

let _pruneTimer = null;

function startPruneTimer() {
  if (_pruneTimer) return;
  _pruneTimer = setInterval(async () => {
    try {
      const pending = await db.adminApprovals.findPending();
      const now = Date.now();
      for (const approval of pending) {
        if (now > approval.expires_at) {
          await db.adminApprovals.update(approval.approval_id, {
            ...approval,
            status: 'expired',
            expired_at: now,
          });
        }
      }
    } catch (err) {
      console.warn('[multisig] Prune timer error:', err.message);
    }
  }, 60000); // every 60 seconds
  if (_pruneTimer.unref) _pruneTimer.unref();
}

// Start pruning on module load (non-blocking)
startPruneTimer();

// ---------------------------------------------------------------------------
// Core middleware factory
// ---------------------------------------------------------------------------

/**
 * Create an Express middleware that enforces M-of-N admin approval for the given action.
 *
 * @param {string} action - Action identifier (must be in MULTISIG_POLICY)
 * @returns {Function} Express middleware (req, res, next)
 */
function requireMultisig(action) {
  const policy = MULTISIG_POLICY[action];
  if (!policy) {
    throw new Error(`[multisig] Unknown action: "${action}". Add it to MULTISIG_POLICY.`);
  }

  return async (req, res, next) => {
    // Skip in dev/test if explicitly disabled
    if (isMultisigDisabled()) {
      return next();
    }

    // Caller must be authenticated as admin (adminAuth middleware runs before this)
    const signerAddress = req.adminAuth?.address;
    if (!signerAddress) {
      // Token-based auth (no wallet address) cannot participate in multi-sig
      return res.status(403).json({
        error: 'Multi-sig requires wallet authentication',
        detail: 'Use wallet signature or admin session (not static token) for multi-sig operations.',
      });
    }

    const { approval_id } = req.body || {};
    const requiredCount = getRequiredCount(action);
    const now = Date.now();

    if (!approval_id) {
      // ── First signer: create approval request ──
      const id = crypto.randomBytes(16).toString('hex');
      const expiresAt = now + policy.expiry_ms;

      // Snapshot the request params (excluding approval_id itself)
      const { approval_id: _, ...params } = req.body || {};

      const record = {
        approval_id: id,
        action,
        params,
        // Also snapshot route params (e.g., :id for trigger/:id/abort)
        route_params: { ...req.params },
        required_approvals: requiredCount,
        current_approvals: [{
          address: signerAddress,
          signed_at: now,
        }],
        status: 'pending',
        created_by: signerAddress,
        created_at: now,
        expires_at: expiresAt,
        executed_at: null,
        result: null,
      };

      await db.adminApprovals.create(id, record);

      // Audit log
      try {
        await db.auditLog.create(`multisig_create_${id}`, {
          type: 'MULTISIG_APPROVAL_CREATED',
          approval_id: id,
          action,
          created_by: signerAddress,
          required_approvals: requiredCount,
          created_at: now,
          expires_at: expiresAt,
        });
      } catch (_) { /* non-fatal */ }

      // Notify other admins
      await notifyAdmins(action, id, signerAddress).catch(() => {});

      // If only 1 approval needed, execute immediately
      if (requiredCount <= 1) {
        record.status = 'approved';
        record.executed_at = now;
        await db.adminApprovals.update(id, record);
        req.body = { ...params };
        return next();
      }

      return res.status(202).json({
        status: 'awaiting_approval',
        approval_id: id,
        action,
        required: requiredCount,
        current: 1,
        signers: [signerAddress],
        expires_at: expiresAt,
        message: `Approval created. ${requiredCount - 1} more admin signature(s) required.`,
      });
    }

    // ── Subsequent signer: approve existing request ──
    const approval = await db.adminApprovals.findById(approval_id);

    if (!approval) {
      return res.status(404).json({ error: 'Approval not found', detail: `No approval with id ${approval_id}` });
    }

    if (approval.status !== 'pending') {
      return res.status(400).json({
        error: 'Approval not pending',
        detail: `This approval is "${approval.status}". Only pending approvals can be signed.`,
      });
    }

    if (approval.action !== action) {
      return res.status(400).json({
        error: 'Action mismatch',
        detail: `This approval is for "${approval.action}", not "${action}".`,
      });
    }

    if (now > approval.expires_at) {
      approval.status = 'expired';
      approval.expired_at = now;
      await db.adminApprovals.update(approval_id, approval);
      return res.status(410).json({
        error: 'Approval expired',
        detail: 'This approval has expired. Please create a new one.',
      });
    }

    // Prevent duplicate signing by same admin
    if (approval.current_approvals.some(a => a.address === signerAddress)) {
      return res.status(409).json({
        error: 'Already signed',
        detail: 'You have already approved this request.',
        approval_id,
        current: approval.current_approvals.length,
        required: approval.required_approvals,
      });
    }

    // Add signature
    approval.current_approvals.push({
      address: signerAddress,
      signed_at: now,
    });

    if (approval.current_approvals.length >= approval.required_approvals) {
      // ── Threshold reached: execute ──
      approval.status = 'approved';
      approval.executed_at = now;
      await db.adminApprovals.update(approval_id, approval);

      // Audit log
      try {
        await db.auditLog.create(`multisig_approved_${approval_id}`, {
          type: 'MULTISIG_APPROVAL_EXECUTED',
          approval_id,
          action,
          signers: approval.current_approvals.map(a => a.address),
          executed_at: now,
        });
      } catch (_) { /* non-fatal */ }

      // Restore original params and route params for the handler
      req.body = { ...approval.params };
      if (approval.route_params) {
        Object.assign(req.params, approval.route_params);
      }
      return next();
    }

    // Still need more signatures
    await db.adminApprovals.update(approval_id, approval);

    return res.status(202).json({
      status: 'awaiting_approval',
      approval_id,
      action,
      required: approval.required_approvals,
      current: approval.current_approvals.length,
      signers: approval.current_approvals.map(a => a.address),
      expires_at: approval.expires_at,
      message: `${approval.required_approvals - approval.current_approvals.length} more admin signature(s) required.`,
    });
  };
}

// ---------------------------------------------------------------------------
// Standalone approval management helpers (for GET /approvals, POST /reject)
// ---------------------------------------------------------------------------

/**
 * List all pending approvals.
 * @returns {Promise<object[]>}
 */
async function listPendingApprovals() {
  const pending = await db.adminApprovals.findPending();
  const now = Date.now();
  // Filter out truly expired ones
  return pending.filter(a => now <= a.expires_at);
}

/**
 * List all approvals (with optional status filter).
 * @param {{ status?: string, limit?: number }} [opts]
 * @returns {Promise<object[]>}
 */
async function listApprovals(opts = {}) {
  let all;
  if (opts.status) {
    all = await db.adminApprovals.findByField('status', opts.status);
  } else {
    all = await db.adminApprovals.findAll();
  }
  // Sort by created_at descending
  all.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  if (opts.limit && opts.limit > 0) {
    return all.slice(0, opts.limit);
  }
  return all;
}

/**
 * Reject a pending approval.
 * @param {string} approvalId
 * @param {string} rejecterAddress
 * @param {string} [reason]
 * @returns {Promise<object>}
 */
async function rejectApproval(approvalId, rejecterAddress, reason) {
  const approval = await db.adminApprovals.findById(approvalId);
  if (!approval) throw new Error('Approval not found');
  if (approval.status !== 'pending') throw new Error(`Approval is "${approval.status}", not pending`);

  const now = Date.now();
  approval.status = 'rejected';
  approval.rejected_at = now;
  approval.rejected_by = rejecterAddress;
  approval.reject_reason = reason || null;
  await db.adminApprovals.update(approvalId, approval);

  try {
    await db.auditLog.create(`multisig_rejected_${approvalId}`, {
      type: 'MULTISIG_APPROVAL_REJECTED',
      approval_id: approvalId,
      action: approval.action,
      rejected_by: rejecterAddress,
      reject_reason: reason || null,
      rejected_at: now,
    });
  } catch (_) { /* non-fatal */ }

  return approval;
}

module.exports = {
  requireMultisig,
  listPendingApprovals,
  listApprovals,
  rejectApproval,
  MULTISIG_POLICY,
};
