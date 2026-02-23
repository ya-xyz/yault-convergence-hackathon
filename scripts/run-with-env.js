#!/usr/bin/env node
/**
 * run-with-env.js — Start server with environment profile
 *
 * Usage: node scripts/run-with-env.js [development|test|production]
 *        ENV_PROFILE=production node scripts/run-with-env.js
 *
 * Load order:
 *   1. env/.env.<profile>  (from env/<profile>.json via generate-env)
 *   2. .env                 (user secrets — overrides)
 *
 * Run generate-env first if env/.env.<profile> is missing.
 */

const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const profile = process.env.ENV_PROFILE || process.argv[2] || 'development';

const validProfiles = ['development', 'test', 'production'];
if (!validProfiles.includes(profile)) {
  console.error(`[run-with-env] Invalid profile: "${profile}". Must be one of: ${validProfiles.join(', ')}`);
  process.exit(1);
}

// Ensure env is generated
const envFile = path.join(root, 'env', `.env.${profile}`);
if (!fs.existsSync(envFile)) {
  console.warn(`[run-with-env] ${envFile} not found. Running generate-env...`);
  const { execSync } = require('child_process');
  execSync(`node scripts/generate-env.mjs ${profile}`, {
    cwd: root,
    stdio: 'inherit',
  });
}

// Load env/.env.<profile> first (defaults from env/*.json)
require('dotenv').config({ path: envFile });
// Load .env (user secrets + overrides) — override: true so .env takes precedence
require('dotenv').config({ path: path.join(root, '.env'), override: true });

process.env.ENV_PROFILE = profile;

// Start server
require(path.join(root, 'server', 'index.js'));
