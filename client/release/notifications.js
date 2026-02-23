/**
 * notifications.js — Notification System
 *
 * Provides in-wallet notification banners and email notification triggers.
 *
 * Note: Inactivity / heartbeat-based alerts have been removed.
 * Release triggers are now initiated by authorities via legal-event API.
 * This module retains the generic notification framework for other alert types
 * (e.g., authority notifications, trigger status updates, vault events).
 */

// ─── Constants ───

const STORAGE_KEY_DISMISSED = 'yallet_dismissed_alerts';

const API_BASE = '/api';

// ─── Internal Helpers ───

/**
 * Load dismissed alerts from local storage.
 * @returns {object} Map of "key" → dismissedAt ISO string
 */
function _loadDismissed() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_DISMISSED) || '{}');
  } catch {
    return {};
  }
}

/**
 * Save dismissed alerts to local storage.
 * @param {object} dismissed
 */
function _saveDismissed(dismissed) {
  try {
    localStorage.setItem(STORAGE_KEY_DISMISSED, JSON.stringify(dismissed));
  } catch {
    // Storage unavailable
  }
}

// ─── Exported Functions ───

/**
 * Determine the alert level from a string.
 *
 * @param {'info' | 'warning' | 'critical' | string} level
 * @returns {'none' | 'info' | 'warning' | 'critical'}
 */
export function getAlertLevel(level) {
  if (['critical', 'warning', 'info'].includes(level)) return level;
  return 'none';
}

/**
 * Check for active trigger-based alerts on recipient paths.
 *
 * Returns alerts for paths that have been triggered or are in cooldown,
 * based on server-side trigger status (not inactivity detection).
 *
 * @param {Array<{ recipientIndex: number, label: string, walletId: string, status: string }>} paths
 * @returns {Promise<Array<{
 *   recipientIndex: number,
 *   label: string,
 *   level: 'info' | 'warning' | 'critical',
 *   message: string,
 *   dismissed: boolean,
 * }>>}
 */
export async function checkTriggerAlerts(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return [];

  const dismissed = _loadDismissed();
  const alerts = [];

  for (const path of paths) {
    if (!path.walletId) continue;

    let level = 'none';
    let message = '';

    // Alert on trigger status changes (not inactivity)
    if (path.status === 'triggered' || path.status === 'pending') {
      level = 'warning';
      message = `Release trigger is pending for ${path.label || 'Recipient ' + path.recipientIndex}. Authority review in progress.`;
    } else if (path.status === 'cooldown') {
      level = 'critical';
      message = `Release decision is in cooldown for ${path.label || 'Recipient ' + path.recipientIndex}. Cancellation window is open.`;
    } else if (path.status === 'released') {
      level = 'info';
      message = `Path has been released for ${path.label || 'Recipient ' + path.recipientIndex}. Recipient can now activate.`;
    }

    if (level === 'none') continue;

    const dismissKey = `${path.recipientIndex}:${level}`;
    const isDismissed = !!dismissed[dismissKey];

    alerts.push({
      recipientIndex: path.recipientIndex,
      label: path.label || `Recipient ${path.recipientIndex}`,
      level,
      message,
      dismissed: isDismissed,
    });
  }

  return alerts;
}

/**
 * Render an in-wallet notification banner for an alert.
 *
 * Returns HTML string suitable for injection into the wallet UI.
 *
 * @param {{ level: string, message: string, recipientIndex: number, label: string }} alert
 * @returns {string} HTML string for the notification banner.
 */
export function showInWalletNotification(alert) {
  if (!alert) return '';

  const levelClass = {
    info: 'alert-info',
    warning: 'alert-warning',
    critical: 'alert-critical',
  }[alert.level] || 'alert-info';

  const icon = alert.level === 'critical' ? '&#9888;'
    : alert.level === 'warning' ? '&#9888;'
    : '&#8505;';

  return `
    <div class="alert-banner ${levelClass}" data-alert-path="${alert.recipientIndex}" data-alert-level="${alert.level}">
      <span class="alert-icon">${icon}</span>
      <div class="alert-content">
        <div class="alert-title">${_escapeHTML(alert.label)}</div>
        <div class="alert-message">${_escapeHTML(alert.message)}</div>
      </div>
      <button class="alert-dismiss" data-action="dismiss-alert" data-path="${alert.recipientIndex}" data-level="${alert.level}">&times;</button>
    </div>
  `;
}

/**
 * Trigger an email notification for an alert via server API.
 *
 * @param {{ level: string, message: string, recipientIndex: number }} alert
 * @param {string} email - User's email address.
 * @returns {Promise<boolean>} Whether the email was sent successfully.
 */
export async function triggerEmailNotification(alert, email) {
  if (!email || !alert) return false;
  if (alert.level === 'info') return false;

  try {
    const response = await fetch(`${API_BASE}/notifications/alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        recipient_index: alert.recipientIndex,
        level: alert.level,
        message: alert.message,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Dismiss an alert for a specific path and level.
 *
 * @param {number} pathIndex - 1-based recipient index.
 * @param {'info' | 'warning' | 'critical'} level
 */
export function dismissAlert(pathIndex, level) {
  const dismissed = _loadDismissed();
  const key = `${pathIndex}:${level}`;
  dismissed[key] = new Date().toISOString();
  _saveDismissed(dismissed);
}

/**
 * Clear all dismissed alerts.
 */
export function clearDismissedAlerts() {
  try {
    localStorage.removeItem(STORAGE_KEY_DISMISSED);
  } catch {
    // Storage unavailable
  }
}

/**
 * Escape HTML characters.
 * @param {string} str
 * @returns {string}
 */
function _escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
