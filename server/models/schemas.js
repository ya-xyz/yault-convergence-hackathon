/**
 * schemas.js — Data Models & Validation
 *
 * Plain validation classes for all domain entities.
 * Each class exposes a static `validate(data)` method that returns
 * `{ valid: true, data: sanitizedObj }` or `{ valid: false, errors: string[] }`.
 *
 * Entities:
 * - AuthorityProfile       // authority registration data
 * - AuthorityFeeStructure  // vault revenue share config
 * - AuthorityUserBinding   // pseudonymous user-authority binding
 * - TriggerEvent           // tlock expiry -> authority notification
 * - ReleaseDecision        // authority release/hold/reject record
 * - RevenueRecord          // vault yield distribution record
 */

'use strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert a field is a non-empty string.
 * @param {object} data
 * @param {string} field
 * @param {string[]} errors
 */
function requireString(data, field, errors) {
  if (typeof data[field] !== 'string' || data[field].trim().length === 0) {
    errors.push(`${field} is required and must be a non-empty string`);
  }
}

/**
 * Assert a field is an array (optionally non-empty).
 * @param {object} data
 * @param {string} field
 * @param {string[]} errors
 * @param {boolean} [nonEmpty=false]
 */
function requireArray(data, field, errors, nonEmpty = false) {
  if (!Array.isArray(data[field])) {
    errors.push(`${field} must be an array`);
  } else if (nonEmpty && data[field].length === 0) {
    errors.push(`${field} must contain at least one element`);
  }
}

/**
 * Assert a field is a positive number.
 * @param {object} data
 * @param {string} field
 * @param {string[]} errors
 */
function requirePositiveNumber(data, field, errors) {
  if (typeof data[field] !== 'number' || data[field] <= 0) {
    errors.push(`${field} must be a positive number`);
  }
}

/**
 * Verify a hex-encoded Ed25519 public key (64 hex chars = 32 bytes).
 * @param {string} pubkey
 * @returns {boolean}
 */
function isValidPubkey(pubkey) {
  return typeof pubkey === 'string' && /^[0-9a-fA-F]{64}$/.test(pubkey);
}

// ---------------------------------------------------------------------------
// AuthorityFeeStructure
// ---------------------------------------------------------------------------

class AuthorityFeeStructure {
  /**
   * Validate a fee-structure object.
   * @param {object} data
   * @returns {{ valid: boolean, data?: object, errors?: string[] }}
   */
  static validate(data) {
    const errors = [];
    if (!data || typeof data !== 'object') {
      return { valid: false, errors: ['fee_structure must be an object'] };
    }

    if (typeof data.base_fee_bps !== 'number' || data.base_fee_bps < 0 || data.base_fee_bps > 10000) {
      errors.push('base_fee_bps must be a number between 0 and 10000');
    }
    if (data.flat_fee_usd !== undefined) {
      if (typeof data.flat_fee_usd !== 'number' || data.flat_fee_usd < 0) {
        errors.push('flat_fee_usd must be a non-negative number');
      }
    }
    if (data.currency && typeof data.currency !== 'string') {
      errors.push('currency must be a string');
    }

    if (errors.length > 0) return { valid: false, errors };

    return {
      valid: true,
      data: {
        base_fee_bps: data.base_fee_bps,
        flat_fee_usd: data.flat_fee_usd || 0,
        currency: data.currency || 'USD',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// AuthorityProfile
// ---------------------------------------------------------------------------

class AuthorityProfile {
  /**
   * Validate an authority registration payload.
   * @param {object} data
   * @returns {{ valid: boolean, data?: object, errors?: string[] }}
   */
  static validate(data) {
    const errors = [];
    if (!data || typeof data !== 'object') {
      return { valid: false, errors: ['body must be an object'] };
    }

    requireString(data, 'name', errors);
    requireString(data, 'bar_number', errors);
    requireString(data, 'jurisdiction', errors);
    requireArray(data, 'specialization', errors, true);
    requireArray(data, 'languages', errors, true);

    if (!isValidPubkey(data.pubkey)) {
      errors.push('pubkey must be a 64-character hex-encoded Ed25519 public key');
    }

    // Fee structure validation (nested)
    if (data.fee_structure) {
      const feeResult = AuthorityFeeStructure.validate(data.fee_structure);
      if (!feeResult.valid) {
        errors.push(...feeResult.errors.map((e) => `fee_structure.${e}`));
      }
    }

    // #17 FIX: Strengthened email regex (RFC 5322 simplified form)
    if (data.email) {
      const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
      if (typeof data.email !== 'string' || !EMAIL_REGEX.test(data.email)) {
        errors.push('email must be a valid email address');
      }
    }
    if (data.website) {
      if (typeof data.website !== 'string' || !/^https?:\/\//.test(data.website)) {
        errors.push('website must be a valid URL starting with http:// or https://');
      }
    }

    if (errors.length > 0) return { valid: false, errors };

    return {
      valid: true,
      data: {
        name: data.name.trim(),
        bar_number: data.bar_number.trim(),
        jurisdiction: data.jurisdiction.trim(),
        specialization: data.specialization,
        languages: data.languages,
        pubkey: data.pubkey.toLowerCase(),
        fee_structure: data.fee_structure
          ? AuthorityFeeStructure.validate(data.fee_structure).data
          : { base_fee_bps: 500, flat_fee_usd: 0, currency: 'USD' },
        email: data.email || null,
        website: data.website || null,
        region: data.region || data.jurisdiction,
        verified: false,
        rating: 0,
        rating_count: 0,
        active_bindings: 0,
        max_capacity: (Number.isInteger(data.max_capacity) && data.max_capacity > 0) ? data.max_capacity : 100,
        created_at: Date.now(),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// AuthorityUserBinding
// ---------------------------------------------------------------------------

class AuthorityUserBinding {
  /**
   * Validate a user-authority binding creation payload.
   * @param {object} data
   * @returns {{ valid: boolean, data?: object, errors?: string[] }}
   */
  static validate(data) {
    const errors = [];
    if (!data || typeof data !== 'object') {
      return { valid: false, errors: ['body must be an object'] };
    }

    requireString(data, 'wallet_id', errors);
    requireString(data, 'authority_id', errors);
    requireArray(data, 'recipient_indices', errors, true);

    // Validate each recipient index is a non-negative integer
    if (Array.isArray(data.recipient_indices)) {
      data.recipient_indices.forEach((idx, i) => {
        if (!Number.isInteger(idx) || idx < 0) {
          errors.push(`recipient_indices[${i}] must be a non-negative integer`);
        }
      });
    }

    if (errors.length > 0) return { valid: false, errors };

    return {
      valid: true,
      data: {
        wallet_id: data.wallet_id,
        authority_id: data.authority_id,
        recipient_indices: data.recipient_indices,
        status: 'active',
        created_at: Date.now(),
        terminated_at: null,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// TriggerEvent
// ---------------------------------------------------------------------------

class TriggerEvent {
  /**
   * Validate a trigger event payload.
   * @param {object} data
   * @returns {{ valid: boolean, data?: object, errors?: string[] }}
   */
  static validate(data) {
    const errors = [];
    if (!data || typeof data !== 'object') {
      return { valid: false, errors: ['body must be an object'] };
    }

    requireString(data, 'wallet_id', errors);
    requireString(data, 'authority_id', errors);

    if (!Number.isInteger(data.recipient_index) || data.recipient_index < 0) {
      errors.push('recipient_index must be a non-negative integer');
    }

    // Optional fields with defaults
    if (data.tlock_round !== undefined && data.tlock_round !== null) {
      if (!Number.isInteger(data.tlock_round) || data.tlock_round < 0) {
        errors.push('tlock_round must be a non-negative integer');
      }
    }
    if (data.arweave_tx_id && typeof data.arweave_tx_id !== 'string') {
      errors.push('arweave_tx_id must be a string');
    }

    if (errors.length > 0) return { valid: false, errors };

    return {
      valid: true,
      data: {
        wallet_id: data.wallet_id,
        authority_id: data.authority_id,
        recipient_index: data.recipient_index,
        tlock_round: data.tlock_round != null ? data.tlock_round : null,
        arweave_tx_id: data.arweave_tx_id || null,
        release_request: data.release_request || null,
        status: 'pending',
        triggered_at: Date.now(),
        decided_at: null,
        decision: null,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// ReleaseDecision
// ---------------------------------------------------------------------------

class ReleaseDecision {
  /** @type {string[]} */
  static VALID_DECISIONS = ['release', 'hold', 'reject'];

  /** @type {string[]} Valid reason codes for audit compliance */
  static VALID_REASON_CODES = [
    'verified_event',
    'incapacity_certification',
    'legal_order',
    'authorized_request',
    'court_order',
    'other',
  ];

  /** Default cooldown period before a release decision takes effect (ms).
   *  Prefer config.cooldown.defaultHours when available (see getDefaultCooldownMs()). */
  static DEFAULT_COOLDOWN_MS = (
    process.env.DEFAULT_COOLDOWN_HOURS !== undefined
      ? parseFloat(process.env.DEFAULT_COOLDOWN_HOURS) * 60 * 60 * 1000
      : 168 * 60 * 60 * 1000 // 168 hours = 1 week (fallback when config not used)
  );

  /**
   * Validate an authority decision payload.
   * @param {object} data
   * @returns {{ valid: boolean, data?: object, errors?: string[] }}
   */
  static validate(data) {
    const errors = [];
    if (!data || typeof data !== 'object') {
      return { valid: false, errors: ['body must be an object'] };
    }

    if (!ReleaseDecision.VALID_DECISIONS.includes(data.decision)) {
      errors.push(`decision must be one of: ${ReleaseDecision.VALID_DECISIONS.join(', ')}`);
    }

    requireString(data, 'evidence_hash', errors);
    requireString(data, 'signature', errors);

    if (data.reason && typeof data.reason !== 'string') {
      errors.push('reason must be a string');
    }

    // Validate reason_code if provided
    if (data.reason_code) {
      if (!ReleaseDecision.VALID_REASON_CODES.includes(data.reason_code)) {
        errors.push(`reason_code must be one of: ${ReleaseDecision.VALID_REASON_CODES.join(', ')}`);
      }
    }

    // matter_id is optional but must be a non-empty string if provided
    if (data.matter_id !== undefined && data.matter_id !== null) {
      if (typeof data.matter_id !== 'string' || data.matter_id.trim().length === 0) {
        errors.push('matter_id must be a non-empty string if provided');
      }
    }

    let maxCooldownHours = 168;
    try {
      const config = require('../config');
      if (config.cooldown && config.cooldown.maxHours != null) maxCooldownHours = config.cooldown.maxHours;
    } catch (_) {}
    if (data.cooldown_hours !== undefined) {
      if (typeof data.cooldown_hours !== 'number' || data.cooldown_hours < 0) {
        errors.push('cooldown_hours must be a non-negative number');
      } else if (data.cooldown_hours > maxCooldownHours) {
        errors.push(`cooldown_hours must not exceed ${maxCooldownHours}`);
      }
    }

    if (errors.length > 0) return { valid: false, errors };

    const now = Date.now();
    let defaultCooldownMs = ReleaseDecision.DEFAULT_COOLDOWN_MS;
    try {
      const config = require('../config');
      if (config.cooldown && config.cooldown.defaultHours != null) {
        defaultCooldownMs = config.cooldown.defaultHours * 60 * 60 * 1000;
      }
    } catch (_) {}
    const cooldownMs = data.cooldown_hours !== undefined
      ? data.cooldown_hours * 60 * 60 * 1000
      : defaultCooldownMs;

    return {
      valid: true,
      data: {
        decision: data.decision,
        evidence_hash: data.evidence_hash,
        signature: data.signature,
        reason: data.reason || '',
        reason_code: data.reason_code || 'other',
        matter_id: data.matter_id ? data.matter_id.trim() : null,
        cooldown_ms: cooldownMs,
        decided_at: now,
        effective_at: cooldownMs > 0 ? now + cooldownMs : now,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// RevenueRecord
// ---------------------------------------------------------------------------

class RevenueRecord {
  /**
   * Validate a revenue distribution record.
   * @param {object} data
   * @returns {{ valid: boolean, data?: object, errors?: string[] }}
   */
  static validate(data) {
    const errors = [];
    if (!data || typeof data !== 'object') {
      return { valid: false, errors: ['body must be an object'] };
    }

    requireString(data, 'wallet_id', errors);
    requirePositiveNumber(data, 'gross_yield', errors);

    if (data.authority_id && typeof data.authority_id !== 'string') {
      errors.push('authority_id must be a string');
    }

    if (errors.length > 0) return { valid: false, errors };

    // #9 FIX: Replace floating-point revenue split with integer-safe arithmetic.
    // Scale to 1e8 precision, use Math.floor for deterministic rounding,
    // remainder to authority to guarantee exact sum.
    const config = require('../config');
    const gross = data.gross_yield;
    const PRECISION = 1e8;
    const grossScaled = Math.round(gross * PRECISION);
    const userScaled = Math.floor((grossScaled * config.revenue.userShareBps) / 10000);
    const platformScaled = Math.floor((grossScaled * config.revenue.platformShareBps) / 10000);
    const authorityScaled = grossScaled - userScaled - platformScaled;
    const userShare = userScaled / PRECISION;
    const platformShare = platformScaled / PRECISION;
    const authorityShare = authorityScaled / PRECISION;

    return {
      valid: true,
      data: {
        wallet_id: data.wallet_id,
        authority_id: data.authority_id || null,
        gross_yield: gross,
        user_share: userShare,
        platform_share: platformShare,
        authority_share: authorityShare,
        period_start: data.period_start || Date.now(),
        period_end: data.period_end || Date.now(),
        status: 'pending',
        created_at: Date.now(),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// SubAccount (parent → member relationship: family, institutional, DAO, etc.)
// ---------------------------------------------------------------------------

class SubAccount {
  /** @type {string[]} */
  static VALID_ACCOUNT_TYPES = ['family', 'institutional'];

  /** @type {string[]} */
  static VALID_ROLES = ['spouse', 'child', 'dependent', 'sub_account', 'employee'];

  /** @type {string[]} */
  static VALID_STATUSES = ['active', 'suspended', 'removed'];

  /** @type {string[]} */
  static VALID_PERIODS = ['daily', 'weekly', 'monthly'];

  /**
   * Validate a sub-account / member creation payload.
   * @param {object} data
   * @returns {{ valid: boolean, data?: object, errors?: string[] }}
   */
  static validate(data) {
    const errors = [];
    if (!data || typeof data !== 'object') {
      return { valid: false, errors: ['body must be an object'] };
    }

    requireString(data, 'parent_wallet_id', errors);
    requireString(data, 'label', errors);

    // member_wallet_id is optional — if not provided, the member must connect their own wallet later
    if (data.member_wallet_id !== undefined && data.member_wallet_id !== null) {
      if (typeof data.member_wallet_id !== 'string' || data.member_wallet_id.trim().length === 0) {
        errors.push('member_wallet_id must be a non-empty string if provided');
      }
    }

    if (!SubAccount.VALID_ACCOUNT_TYPES.includes(data.account_type)) {
      errors.push(`account_type must be one of: ${SubAccount.VALID_ACCOUNT_TYPES.join(', ')}`);
    }

    if (!SubAccount.VALID_ROLES.includes(data.role)) {
      errors.push(`role must be one of: ${SubAccount.VALID_ROLES.join(', ')}`);
    }

    // Validate permissions if provided
    if (data.permissions) {
      if (typeof data.permissions !== 'object') {
        errors.push('permissions must be an object');
      } else {
        if (data.permissions.withdrawal_limit !== undefined && data.permissions.withdrawal_limit !== null) {
          if (typeof data.permissions.withdrawal_limit !== 'number' || data.permissions.withdrawal_limit < 0) {
            errors.push('permissions.withdrawal_limit must be a non-negative number');
          }
        }
        if (data.permissions.withdrawal_period !== undefined) {
          if (!SubAccount.VALID_PERIODS.includes(data.permissions.withdrawal_period)) {
            errors.push(`permissions.withdrawal_period must be one of: ${SubAccount.VALID_PERIODS.join(', ')}`);
          }
        }
      }
    }

    if (errors.length > 0) return { valid: false, errors };

    const perms = data.permissions || {};
    return {
      valid: true,
      data: {
        parent_wallet_id: data.parent_wallet_id.trim(),
        member_wallet_id: data.member_wallet_id ? data.member_wallet_id.trim() : null,
        account_type: data.account_type,
        role: data.role,
        label: data.label.trim(),
        permissions: {
          can_view_balance: perms.can_view_balance !== false,
          can_withdraw: !!perms.can_withdraw,
          withdrawal_limit: perms.withdrawal_limit != null ? perms.withdrawal_limit : null,
          withdrawal_period: perms.withdrawal_period || 'monthly',
          can_deposit: perms.can_deposit !== false,
          can_bind_authority: !!perms.can_bind_authority,
        },
        status: 'active',
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Allowance (fund transfer between parent and sub-account)
// ---------------------------------------------------------------------------

class Allowance {
  /** @type {string[]} */
  static VALID_TYPES = ['one_time', 'recurring'];

  /** @type {string[]} */
  static VALID_FREQUENCIES = ['daily', 'weekly', 'monthly'];

  /**
   * Validate an allowance / fund transfer payload.
   * @param {object} data
   * @returns {{ valid: boolean, data?: object, errors?: string[] }}
   */
  static validate(data) {
    const errors = [];
    if (!data || typeof data !== 'object') {
      return { valid: false, errors: ['body must be an object'] };
    }

    requireString(data, 'from_wallet_id', errors);
    requireString(data, 'to_wallet_id', errors);
    requireString(data, 'amount', errors);

    // Amount must be a parseable positive number (stored as string for precision)
    if (typeof data.amount === 'string' && data.amount.trim().length > 0) {
      const num = Number(data.amount);
      if (isNaN(num) || num <= 0) {
        errors.push('amount must be a positive number');
      }
    }

    if (data.type && !Allowance.VALID_TYPES.includes(data.type)) {
      errors.push(`type must be one of: ${Allowance.VALID_TYPES.join(', ')}`);
    }

    // Validate recurring_config if type is recurring
    if (data.type === 'recurring') {
      if (!data.recurring_config || typeof data.recurring_config !== 'object') {
        errors.push('recurring_config is required for recurring allowances');
      } else {
        if (!Allowance.VALID_FREQUENCIES.includes(data.recurring_config.frequency)) {
          errors.push(`recurring_config.frequency must be one of: ${Allowance.VALID_FREQUENCIES.join(', ')}`);
        }
      }
    }

    if (errors.length > 0) return { valid: false, errors };

    return {
      valid: true,
      data: {
        from_wallet_id: data.from_wallet_id.trim(),
        to_wallet_id: data.to_wallet_id.trim(),
        amount: data.amount.trim(),
        currency: data.currency || 'ETH',
        type: data.type || 'one_time',
        recurring_config: data.type === 'recurring' ? {
          frequency: data.recurring_config.frequency,
          next_execution: data.recurring_config.next_execution || Date.now(),
          end_date: data.recurring_config.end_date || null,
        } : null,
        memo: (data.memo || '').trim(),
        status: data.type === 'recurring' ? 'active' : 'completed',
        created_at: Date.now(),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// CampaignConfig — rebate campaign validation (placeholder for referral / fee-waiver)
// ---------------------------------------------------------------------------

class CampaignConfig {
  static VALID_STATUSES = ['draft', 'active', 'paused', 'ended'];

  /**
   * @param {object} data
   * @returns {{ valid: true, data: object } | { valid: false, errors: string[] }}
   */
  static validate(data) {
    const errors = [];
    if (!data || typeof data !== 'object') {
      return { valid: false, errors: ['body must be an object'] };
    }
    requireString(data, 'name', errors);
    if (data.enabled !== undefined && typeof data.enabled !== 'boolean') {
      errors.push('enabled must be a boolean');
    }
    if (data.rebate_bps !== undefined) {
      if (typeof data.rebate_bps !== 'number' || data.rebate_bps < 0 || data.rebate_bps > 10000) {
        errors.push('rebate_bps must be between 0 and 10000');
      }
    }
    if (data.max_per_user_bps !== undefined) {
      if (typeof data.max_per_user_bps !== 'number' || data.max_per_user_bps < 0 || data.max_per_user_bps > 10000) {
        errors.push('max_per_user_bps must be between 0 and 10000');
      }
    }
    if (data.referral_yield_boost_bps !== undefined) {
      if (typeof data.referral_yield_boost_bps !== 'number' || data.referral_yield_boost_bps < 0 || data.referral_yield_boost_bps > 10000) {
        errors.push('referral_yield_boost_bps must be between 0 and 10000');
      }
    }
    if (data.invitee_fee_waiver_days !== undefined) {
      if (typeof data.invitee_fee_waiver_days !== 'number' || data.invitee_fee_waiver_days < 0) {
        errors.push('invitee_fee_waiver_days must be a non-negative number');
      }
    }
    if (data.start_date && isNaN(Date.parse(data.start_date))) {
      errors.push('start_date must be a valid ISO date string');
    }
    if (data.end_date && isNaN(Date.parse(data.end_date))) {
      errors.push('end_date must be a valid ISO date string');
    }
    if (data.status && !CampaignConfig.VALID_STATUSES.includes(data.status)) {
      errors.push(`status must be one of: ${CampaignConfig.VALID_STATUSES.join(', ')}`);
    }
    if (errors.length > 0) return { valid: false, errors };
    return {
      valid: true,
      data: {
        name: data.name.trim(),
        enabled: data.enabled || false,
        rebate_bps: data.rebate_bps || 0,
        max_per_user_bps: data.max_per_user_bps || 500,
        start_date: data.start_date || null,
        end_date: data.end_date || null,
        referral_yield_boost_bps: data.referral_yield_boost_bps || 0,
        invitee_fee_waiver_days: data.invitee_fee_waiver_days || 0,
        status: data.status || 'draft',
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  AuthorityProfile,
  AuthorityFeeStructure,
  AuthorityUserBinding,
  TriggerEvent,
  ReleaseDecision,
  RevenueRecord,
  SubAccount,
  Allowance,
  CampaignConfig,
};
