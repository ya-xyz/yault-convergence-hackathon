/**
 * tlock.js — Unit Tests
 *
 * Tests for drand timelock encryption wrapper.
 * Uses Jest with mock fetch for API calls.
 */

import {
  getDrandConfig,
  getCurrentRound,
  computeFutureRound,
  buildReleaseRequest,
} from '../../client/release/tlock.js';

// ─── getDrandConfig ───

describe('getDrandConfig', () => {
  test('returns expected configuration shape', () => {
    const config = getDrandConfig();
    expect(config).toHaveProperty('genesis');
    expect(config).toHaveProperty('period');
    expect(config).toHaveProperty('chainHash');
    expect(config).toHaveProperty('urls');
    expect(config.genesis).toBe(1595431050);
    expect(config.period).toBe(30);
    expect(config.chainHash).toMatch(/^[0-9a-f]{64}$/);
    expect(config.urls).toBeInstanceOf(Array);
    expect(config.urls.length).toBeGreaterThanOrEqual(1);
  });

  test('returns a copy (not mutable reference)', () => {
    const a = getDrandConfig();
    const b = getDrandConfig();
    a.urls.push('http://evil.com');
    expect(b.urls).not.toContain('http://evil.com');
  });
});

// ─── getCurrentRound ───

describe('getCurrentRound', () => {
  test('returns a positive integer', () => {
    const round = getCurrentRound();
    expect(Number.isInteger(round)).toBe(true);
    expect(round).toBeGreaterThan(0);
  });

  test('is consistent with drand genesis and period', () => {
    const config = getDrandConfig();
    const nowSec = Math.floor(Date.now() / 1000);
    const expected = Math.floor((nowSec - config.genesis) / config.period) + 1;
    const actual = getCurrentRound();
    // Allow 1 round tolerance for timing
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
  });
});

// ─── computeFutureRound ───

describe('computeFutureRound', () => {
  test('returns round and timestamp for 12 months', () => {
    const result = computeFutureRound(12);
    expect(result).toHaveProperty('round');
    expect(result).toHaveProperty('estimatedTimestamp');
    expect(result.round).toBeGreaterThan(getCurrentRound());
    expect(result.estimatedTimestamp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('throws for zero or negative months', () => {
    expect(() => computeFutureRound(0)).toThrow();
    expect(() => computeFutureRound(-1)).toThrow();
  });

  test('throws for non-finite input', () => {
    expect(() => computeFutureRound(NaN)).toThrow();
    expect(() => computeFutureRound(Infinity)).toThrow();
  });

  test('larger monthsFromNow yields larger round', () => {
    const r6 = computeFutureRound(6);
    const r12 = computeFutureRound(12);
    const r24 = computeFutureRound(24);
    expect(r12.round).toBeGreaterThan(r6.round);
    expect(r24.round).toBeGreaterThan(r12.round);
  });

  test('1 month yields approximately 30 days of rounds', () => {
    const current = getCurrentRound();
    const result = computeFutureRound(1);
    const config = getDrandConfig();
    const expectedRounds = Math.round(30.44 * 24 * 3600 / config.period);
    const actualRounds = result.round - current;
    // Allow 5% tolerance
    expect(Math.abs(actualRounds - expectedRounds) / expectedRounds).toBeLessThan(0.05);
  });
});

// ─── buildReleaseRequest ───

describe('buildReleaseRequest', () => {
  test('builds valid JSON release request', () => {
    const json = buildReleaseRequest('wallet123', 1, 'authority456', {
      email: 'test@example.com',
      name: 'Test User',
    });

    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.type).toBe('RELEASE_REQUEST');
    expect(parsed.walletId).toBe('wallet123');
    expect(parsed.recipientIndex).toBe(1);
    expect(parsed.authorityId).toBe('authority456');
    expect(parsed.contact.email).toBe('test@example.com');
    expect(parsed.contact.name).toBe('Test User');
    expect(parsed.createdAt).toBeTruthy();
  });

  test('throws for missing walletId', () => {
    expect(() => buildReleaseRequest('', 1, 'authority456', {})).toThrow();
    expect(() => buildReleaseRequest(null, 1, 'authority456', {})).toThrow();
  });

  test('throws for missing authorityId', () => {
    expect(() => buildReleaseRequest('wallet123', 1, '', {})).toThrow();
  });

  test('throws for invalid recipientIndex', () => {
    expect(() => buildReleaseRequest('wallet123', 0, 'authority456', {})).toThrow();
    expect(() => buildReleaseRequest('wallet123', -1, 'authority456', {})).toThrow();
    expect(() => buildReleaseRequest('wallet123', 1.5, 'authority456', {})).toThrow();
  });

  test('handles empty contact object', () => {
    const json = buildReleaseRequest('wallet123', 1, 'authority456', {});
    const parsed = JSON.parse(json);
    expect(parsed.contact.email).toBeNull();
    expect(parsed.contact.phone).toBeNull();
    expect(parsed.contact.name).toBeNull();
  });

  test('handles null contact', () => {
    const json = buildReleaseRequest('wallet123', 1, 'authority456', null);
    const parsed = JSON.parse(json);
    expect(parsed.contact.email).toBeNull();
  });
});
