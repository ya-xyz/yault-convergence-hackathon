/**
 * email.js — Email Notification Service
 *
 * Sends notifications to authorities and users for platform events.
 * Uses a pluggable provider pattern: console.log in dev, SendGrid/Resend/Mailgun in prod.
 *
 * Exports:
 * - sendTriggerNotification(authorityEmail, walletId, recipientIndex)
 * - sendInactivityWarning(userEmail, monthsRemaining)
 * - sendDecisionConfirmation(authorityEmail, triggerId, decision)
 */

'use strict';
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Provider abstraction
// ---------------------------------------------------------------------------

/**
 * Resolve the email provider based on environment.
 * Returns an object with a `send(to, subject, body)` method.
 *
 * @returns {{ send: (to: string, subject: string, body: string) => Promise<void> }}
 */
function getProvider() {
  const apiKey = process.env.EMAIL_API_KEY;
  const provider = process.env.EMAIL_PROVIDER || 'console';

  if (provider === 'sendgrid' && apiKey) {
    return {
      name: 'sendgrid',
      async send(to, subject, body, html) {
        // Dynamic import so the dependency is optional
        const sgMail = require('@sendgrid/mail');
        sgMail.setApiKey(apiKey);
        await sgMail.send({
          to,
          from: process.env.EMAIL_FROM || 'noreply@yault.xyz',
          subject,
          text: body,
          html: html || undefined,
        });
      },
    };
  }

  if (provider === 'resend' && apiKey) {
    return {
      name: 'resend',
      async send(to, subject, body, html) {
        const { Resend } = require('resend');
        const resend = new Resend(apiKey);
        await resend.emails.send({
          from: process.env.EMAIL_FROM || 'noreply@yault.xyz',
          to,
          subject,
          text: body,
          html: html || undefined,
        });
      },
    };
  }

  if (provider === 'mailgun' && apiKey) {
    return {
      name: 'mailgun',
      async send(to, subject, body, html) {
        const domain = process.env.MAILGUN_DOMAIN;
        if (!domain) throw new Error('MAILGUN_DOMAIN is required');
        const from = process.env.EMAIL_FROM || 'noreply@yault.xyz';
        const url = `https://api.mailgun.net/v3/${domain}/messages`;

        // Use Node built-in https to avoid extra dependency
        const { request } = require('https');
        const { URL } = require('url');
        const formFields = [
          `from=${encodeURIComponent(from)}`,
          `to=${encodeURIComponent(to)}`,
          `subject=${encodeURIComponent(subject)}`,
          `text=${encodeURIComponent(body)}`,
        ];
        if (html) {
          formFields.push(`html=${encodeURIComponent(html)}`);
        }
        const formData = formFields.join('&');
        const parsed = new URL(url);

        await new Promise((resolve, reject) => {
          const req = request({
            hostname: parsed.hostname,
            path: parsed.pathname,
            method: 'POST',
            headers: {
              'Authorization': 'Basic ' + Buffer.from('api:' + apiKey).toString('base64'),
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(formData),
            },
          }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve();
              } else {
                reject(new Error(`Mailgun API error ${res.statusCode}: ${data}`));
              }
            });
          });
          req.on('error', reject);
          req.write(formData);
          req.end();
        });
      },
    };
  }

  // Default: console provider (development)
  return {
    name: 'console',
    async send(to, subject, body, html) {
      console.log('=== EMAIL (dev) ===');
      console.log(`  To:      ${to}`);
      console.log(`  Subject: ${subject}`);
      console.log(`  Body:    ${body.substring(0, 200)}${body.length > 200 ? '...' : ''}`);
      if (html) {
        console.log(`  HTML:    ${html.substring(0, 200)}${html.length > 200 ? '...' : ''}`);
      }
      console.log('===================');
    },
  };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadTemplate(name) {
  const p = path.join(__dirname, '..', 'templates', name);
  return fs.readFileSync(p, 'utf8');
}

function renderTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : ''));
}

// ---------------------------------------------------------------------------
// Notification functions
// ---------------------------------------------------------------------------

/**
 * Notify an authority that a tlock trigger has expired and a recipient
 * release decision is required.
 *
 * @param {string} authorityEmail - Authority contact email
 * @param {string} walletId - Pseudonymous wallet identifier
 * @param {number} recipientIndex - Index of the recipient requesting release
 * @returns {Promise<void>}
 */
async function sendTriggerNotification(authorityEmail, walletId, recipientIndex) {
  if (!authorityEmail) {
    console.warn('[email] sendTriggerNotification: no email provided, skipping');
    return;
  }

  const provider = getProvider();
  const subject = '[Yault] Release Trigger — Decision Required';
  const body = [
    'A release trigger event has been activated on the Yault platform.',
    '',
    `Wallet ID:         ${walletId}`,
    `Recipient Index:   ${recipientIndex}`,
    '',
    'The tlock time-lock has expired and the designated recipient is requesting',
    'release of assets. Please log in to the Yault authority dashboard',
    'to review the case and submit your release, hold, or reject decision.',
    '',
    'Dashboard: https://app.yault.xyz/authority/triggers',
    '',
    'This is an automated notification from the Yault Platform.',
  ].join('\n');

  await provider.send(authorityEmail, subject, body);
}

/**
 * Send a periodic reminder to a recipient about their
 * credentials (e.g., annual Mnemonic / UserCred reminder).
 *
 * Note: This replaces the old heartbeat inactivity warning. The platform
 * no longer uses activity-detection; triggers are authority-initiated.
 *
 * @param {string} userEmail - Recipient contact email
 * @param {string} hint - A password hint or reminder text (no secrets!)
 * @returns {Promise<void>}
 */
async function sendCredentialReminder(userEmail, hint) {
  if (!userEmail) {
    console.warn('[email] sendCredentialReminder: no email provided, skipping');
    return;
  }

  const provider = getProvider();
  const subject = '[Yault] Annual Credential Reminder';
  const body = [
    'This is your annual reminder from the Yault Platform.',
    '',
    'Please verify that you still have access to the credentials provided',
    'to you as part of the release setup.',
    '',
    hint ? `Hint: ${hint}` : '',
    '',
    'If you have lost your credentials, please contact your designated',
    'authority to discuss recovery options.',
    '',
    'This is an automated notification from the Yault Platform.',
  ].filter(Boolean).join('\n');

  await provider.send(userEmail, subject, body);
}

/**
 * Confirm to an authority that their decision has been recorded.
 *
 * @param {string} authorityEmail - Authority contact email
 * @param {string} triggerId - The trigger event ID
 * @param {string} decision - "release" | "hold" | "reject"
 * @returns {Promise<void>}
 */
async function sendDecisionConfirmation(authorityEmail, triggerId, decision) {
  if (!authorityEmail || !decision) return;

  const provider = getProvider();
  const decisionStr = String(decision).toUpperCase();
  const subject = `[Yault] Decision Recorded — ${decisionStr}`;
  const body = [
    `Your decision for trigger ${triggerId} has been recorded.`,
    '',
    `Decision: ${decisionStr}`,
    '',
    'The decision has been cryptographically signed and will be stored as',
    'part of the immutable audit trail.',
    '',
    'This is an automated notification from the Yault Platform.',
  ].join('\n');

  await provider.send(authorityEmail, subject, body);
}

/**
 * Notify recipients that a release trigger has entered cooldown (release will take effect after effective_at).
 * Sends to each email in the array; used for authority and/or wallet owner notification.
 *
 * @param {string[]} toEmails - List of email addresses to notify (e.g. authority, admin)
 * @param {object} opts - { triggerId, walletId, recipientIndex, effectiveAt }
 * @returns {Promise<void>}
 */
async function sendCooldownNotification(toEmails, opts) {
  const { triggerId, walletId, recipientIndex, effectiveAt } = opts || {};
  if (!Array.isArray(toEmails) || toEmails.length === 0) return;
  const effectiveDate = effectiveAt ? new Date(effectiveAt).toISOString() : '';

  const provider = getProvider();
  const subject = '[Yault] Release Trigger — Cooldown Started';
  const body = [
    'A release trigger has entered the cooldown period.',
    '',
    `Trigger ID:       ${triggerId || '—'}`,
    `Wallet ID:        ${walletId || '—'}`,
    `Recipient Index:  ${recipientIndex != null ? recipientIndex : '—'}`,
    `Release effective at: ${effectiveDate || '—'}`,
    '',
    'During cooldown the decision can be cancelled. After the effective time, release will be finalized.',
    '',
    'This is an automated notification from the Yault Platform.',
  ].join('\n');

  for (const to of toEmails) {
    if (to && typeof to === 'string' && to.trim()) {
      try {
        await provider.send(to.trim(), subject, body);
      } catch (err) {
        console.warn('[email] sendCooldownNotification failed for', to, err.message);
      }
    }
  }
}

/**
 * Send a trial request notification to the platform admin.
 *
 * @param {object} params
 * @param {string} params.name - Applicant name
 * @param {string} params.email - Applicant email
 * @param {string} params.xAccount - X (Twitter) handle
 * @param {string} params.linkedin - LinkedIn profile URL
 * @param {string} params.organization - Organization / institution
 * @param {string} params.purpose - Trial purpose description
 * @returns {Promise<void>}
 */
async function sendTrialRequest({ name, email, xAccount, linkedin, organization, purpose }) {
  const provider = getProvider();
  const adminEmail = process.env.TRIAL_REQUEST_EMAIL || 'jason@yeah.app';
  const subject = `[Yault] Trial Request — ${name}`;
  const body = [
    'A new trial request has been submitted on the Yault platform.',
    '',
    `Name:         ${name}`,
    `Email:        ${email}`,
    `X (Twitter):  ${xAccount || 'N/A'}`,
    `LinkedIn:     ${linkedin || 'N/A'}`,
    `Organization: ${organization || 'N/A'}`,
    '',
    'Purpose:',
    purpose || 'N/A',
    '',
    '---',
    'This is an automated notification from the Yault Platform.',
  ].join('\n');

  await provider.send(adminEmail, subject, body);
}

/**
 * Send a platform invite email to a potential user.
 *
 * @param {string} recipientEmail - Invitee email
 * @param {string} inviterName - Display name / label of the inviter
 * @param {string} inviteLink - Accept-invite URL
 * @returns {Promise<void>}
 */
async function sendInviteEmail(recipientEmail, inviterName, inviteLink) {
  if (!recipientEmail) {
    console.warn('[email] sendInviteEmail: no email provided, skipping');
    return;
  }

  const provider = getProvider();
  const subject = `[Yault] ${inviterName || 'A Yault user'} invited you to join`;
  const body = [
    `${inviterName || 'A Yault user'} has invited you to join the Yault platform.`,
    '',
    'Yault is a self-custodial crypto treasury platform.',
    '',
    inviteLink ? `Accept the invitation: ${inviteLink}` : '',
    'If Yallet is not installed, the page will prompt installation before acceptance.',
    '',
    'This is an automated invitation from the Yault Platform.',
  ].filter(Boolean).join('\n');
  let html = '';
  try {
    const tpl = loadTemplate('invite-email.html');
    html = renderTemplate(tpl, {
      inviterName: escapeHtml(inviterName || 'A Yault user'),
      inviteLink: escapeHtml(inviteLink || '#'),
      recipientEmail: escapeHtml(recipientEmail),
      year: String(new Date().getFullYear()),
    });
  } catch (err) {
    console.warn('[email] invite html template load failed, fallback to text-only:', err.message);
  }

  await provider.send(recipientEmail, subject, body, html || undefined);
}

/**
 * Send a generic test email to validate provider wiring.
 *
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} body - Email body text
 * @param {object} [meta] - Optional metadata for audit context
 * @returns {Promise<void>}
 */
async function sendTestEmail(to, subject, body, meta = {}) {
  if (!to || typeof to !== 'string' || !to.trim()) {
    throw new Error('Recipient email is required');
  }
  const provider = getProvider();
  const providerName = provider.name || 'unknown';
  const metaLines = [
    '---',
    'This is an automated test email from Yault admin API.',
    `Provider: ${providerName}`,
    `Time: ${new Date().toISOString()}`,
  ];
  if (meta.triggeredBy) metaLines.push(`Triggered by: ${meta.triggeredBy}`);
  if (meta.authMethod) metaLines.push(`Auth method: ${meta.authMethod}`);
  const content = [body || 'Email provider test', '', ...metaLines].join('\n');
  await provider.send(to.trim(), subject || '[Yault] Email Test', content);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  sendTriggerNotification,
  sendCredentialReminder,
  sendDecisionConfirmation,
  sendCooldownNotification,
  sendTrialRequest,
  sendInviteEmail,
  sendTestEmail,
  /** Exposed for testing */
  _getProvider: getProvider,
};
