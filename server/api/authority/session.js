/**
 * POST /api/authority/session
 *
 * Exchange one-time wallet signature for a session token.
 * Authority dashboard uses this so the user signs once; subsequent API calls
 * use X-Authority-Session header instead of a new challenge each time.
 *
 * Body: { challenge_id, signature, wallet_type }
 * Returns: { session_token, authority_id, expires_at }
 */
'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const { verifySignature, verifyClientSessionToken } = require('../../middleware/auth');
const db = require('../../db');

const router = Router();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SESSIONS = 200;
const SESSION_RATE_LIMIT = 5; // max session creations per IP per minute
const SESSION_RATE_WINDOW_MS = 60 * 1000;

const sessionCreateTracker = new Map(); // IP -> { count, resetAt }

// #18 FIX: Periodic cleanup of expired tracker entries to prevent memory leak
const TRACKER_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const TRACKER_MAX_SIZE = 50000; // emergency cleanup threshold
let _trackerCleanupTimer = null;

function _startTrackerCleanup() {
  if (_trackerCleanupTimer) return;
  _trackerCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of sessionCreateTracker) {
      if (entry.resetAt <= now) {
        sessionCreateTracker.delete(ip);
      }
    }
  }, TRACKER_CLEANUP_INTERVAL_MS);
  if (_trackerCleanupTimer.unref) _trackerCleanupTimer.unref();
}
_startTrackerCleanup();

router.post('/', async (req, res) => {
  try {
    const now = Date.now();
    const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';

    // Optional: exchange client session for authority session (no second Passkey)
    const clientSession = req.headers['x-client-session'];
    if (clientSession) {
      const session = verifyClientSessionToken(clientSession);
      if (session && session.pubkey) {
        const pubkeyHex = (session.pubkey || '').replace(/^0x/i, '').toLowerCase();
        const authorityId = crypto.createHash('sha256').update(pubkeyHex, 'hex').digest('hex');
        const authority = await db.authorities.findById(authorityId);
        if (authority) {
          const allSessions = await db.authoritySessions.findAll();
          if (allSessions.length >= MAX_SESSIONS) {
            const oldest = allSessions.sort((a, b) => a.expires - b.expires)[0];
            if (oldest && oldest._sessionId) {
              await db.authoritySessions.delete(oldest._sessionId);
            }
          }
          const sessionToken = crypto.randomBytes(32).toString('hex');
          const expiresAt = Date.now() + SESSION_TTL_MS;
          await db.authoritySessions.create(sessionToken, {
            _sessionId: sessionToken,
            authority_id: authorityId,
            pubkey: pubkeyHex,
            expires: expiresAt,
          });
          return res.json({
            session_token: sessionToken,
            authority_id: authorityId,
            expires_at: expiresAt,
          });
        }
        return res.status(403).json({
          error: 'Not registered as authority',
          detail: 'This wallet is not registered as an authority.',
        });
      }
    }

    // Rate limit session creation by IP (abuse / DoS prevention)
    if (sessionCreateTracker.size >= TRACKER_MAX_SIZE) {
      for (const [ip, entry] of sessionCreateTracker) {
        if (entry.resetAt <= now) sessionCreateTracker.delete(ip);
      }
    }
    const tracker = sessionCreateTracker.get(clientIp);
    if (tracker && tracker.resetAt > now) {
      if (tracker.count >= SESSION_RATE_LIMIT) {
        return res.status(429).json({
          error: 'Too many session requests',
          detail: 'Please try again later.',
        });
      }
      tracker.count++;
    } else {
      sessionCreateTracker.set(clientIp, { count: 1, resetAt: now + SESSION_RATE_WINDOW_MS });
    }

    const { challenge_id, signature, wallet_type } = req.body || {};
    if (!challenge_id || !signature) {
      return res.status(400).json({ error: 'challenge_id and signature are required' });
    }

    const result = verifySignature(challenge_id, signature, wallet_type || 'yallet');
    if (!result.valid) {
      return res.status(401).json({ error: result.error || 'Signature verification failed' });
    }

    const pubkeyHex = result.pubkey.replace(/^0x/i, '').toLowerCase();
    const authorityId = crypto.createHash('sha256').update(pubkeyHex, 'hex').digest('hex');

    const authority = await db.authorities.findById(authorityId);
    if (!authority) {
      return res.status(403).json({
        error: 'Not registered as authority',
        detail: 'This wallet is not registered as an authority. Register first via the Authority portal.',
      });
    }

    const allSessions = await db.authoritySessions.findAll();
    if (allSessions.length >= MAX_SESSIONS) {
      const oldest = allSessions.sort((a, b) => a.expires - b.expires)[0];
      if (oldest && oldest._sessionId) {
        await db.authoritySessions.delete(oldest._sessionId);
      }
    }

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    await db.authoritySessions.create(sessionToken, {
      _sessionId: sessionToken,
      authority_id: authorityId,
      pubkey: pubkeyHex,
      expires: expiresAt,
    });

    return res.json({
      session_token: sessionToken,
      authority_id: authorityId,
      expires_at: expiresAt,
    });
  } catch (err) {
    console.error('[authority/session] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
