/**
 * GET /api/authority/search
 *
 * Search and filter available authorities.
 *
 * Query params:
 *   region          - Filter by jurisdiction/region (case-insensitive)
 *   language        - Filter by supported language (case-insensitive)
 *   specialization  - Filter by specialization (case-insensitive)
 *   min_rating      - Minimum average rating (number)
 *   verified        - Only show verified firms (boolean string "true")
 *   limit           - Max results (default 20, max 100)
 *   offset          - Pagination offset (default 0)
 *
 * Returns: { results: AuthorityProfile[], total: number }
 */

'use strict';

const { Router } = require('express');
const db = require('../../db');

const router = Router();

/**
 * @route GET /
 * @description Search for authorities matching filter criteria.
 */
router.get('/', async (req, res) => {
  try {
    const {
      region,
      language,
      specialization,
      min_rating,
      verified,
      limit: limitStr,
      offset: offsetStr,
    } = req.query;

    const limit = Math.min(Math.max(parseInt(limitStr, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(offsetStr, 10) || 0, 0);

    // #16 FIX: Use findByField when only verified filter is active (avoids full table scan)
    let allAuthorities;
    const onlyVerifiedFilter = verified === 'true' && !region && !language && !specialization && !min_rating;
    if (onlyVerifiedFilter) {
      allAuthorities = await db.authorities.findByField('verified', true);
    } else {
      allAuthorities = await db.authorities.findAll();
    }

    let filtered = allAuthorities;

    if (region) {
      const regionLower = region.toLowerCase();
      filtered = filtered.filter(
        (l) => l.region && l.region.toLowerCase().includes(regionLower)
      );
    }

    if (language) {
      const langLower = language.toLowerCase();
      filtered = filtered.filter(
        (l) =>
          Array.isArray(l.languages) &&
          l.languages.some((lang) => lang.toLowerCase() === langLower)
      );
    }

    if (specialization) {
      const specLower = specialization.toLowerCase();
      filtered = filtered.filter(
        (l) =>
          Array.isArray(l.specialization) &&
          l.specialization.some((s) => s.toLowerCase() === specLower)
      );
    }

    if (min_rating) {
      const minRating = parseFloat(min_rating);
      if (!isNaN(minRating)) {
        filtered = filtered.filter((l) => (l.rating || 0) >= minRating);
      }
    }

    if (verified === 'true') {
      filtered = filtered.filter((l) => l.verified === true);
    }

    const total = filtered.length;

    // Sort by rating descending, then by name
    filtered.sort((a, b) => {
      if ((b.rating || 0) !== (a.rating || 0)) return (b.rating || 0) - (a.rating || 0);
      return (a.name || '').localeCompare(b.name || '');
    });

    // Paginate
    const results = filtered.slice(offset, offset + limit).map((l) => ({
      authority_id: l.authority_id,
      name: l.name,
      jurisdiction: l.jurisdiction,
      region: l.region,
      specialization: l.specialization,
      languages: l.languages,
      rating: l.rating,
      rating_count: l.rating_count,
      verified: l.verified,
      fee_structure: l.fee_structure,
      active_bindings: l.active_bindings,
      max_capacity: l.max_capacity,
    }));

    return res.json({ results, total, limit, offset });
  } catch (err) {
    console.error('[authority/search] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
