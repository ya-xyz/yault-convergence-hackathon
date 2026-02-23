/**
 * server/api/trial/request.js — Trial Request Endpoint
 *
 * POST /api/trial/request
 * Body: { name, email, x_account, linkedin, organization, purpose }
 *
 * Public endpoint (no auth required). Sends a notification email
 * with the trial request details to the platform admin.
 */

'use strict';

const { Router } = require('express');
const { sendTrialRequest } = require('../../services/email');

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/', async (req, res) => {
  try {
    const { name, email, x_account, linkedin, organization, purpose } = req.body || {};

    // --- Validation ---
    const errors = [];
    if (!name || !String(name).trim()) errors.push('name is required');
    if (!email || !EMAIL_RE.test(String(email).trim())) errors.push('a valid email is required');
    if (!purpose || !String(purpose).trim()) errors.push('purpose is required');

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    await sendTrialRequest({
      name: String(name).trim(),
      email: String(email).trim(),
      xAccount: x_account ? String(x_account).trim() : '',
      linkedin: linkedin ? String(linkedin).trim() : '',
      organization: organization ? String(organization).trim() : '',
      purpose: String(purpose).trim(),
    });

    return res.json({ ok: true, message: 'Trial request submitted successfully.' });
  } catch (err) {
    console.error('[trial/request] Failed to send trial request:', err.message);
    return res.status(500).json({ error: 'Failed to submit trial request. Please try again later.' });
  }
});

module.exports = router;
