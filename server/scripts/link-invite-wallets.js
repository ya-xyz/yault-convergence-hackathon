/**
 * Link wallet addresses to accepted invites (sub-accounts).
 * Usage (from project root):
 *   node server/scripts/link-invite-wallets.js <email1> <address1> <email2> <address2>
 * Example:
 *   node server/scripts/link-invite-wallets.js \
 *     w7938866@gmail.com 0xYourFirstYalletAddress \
 *     zwanjas@gmail.com  0xYourSecondYalletAddress
 *
 * Database: defaults to data/yault.db (same as server). Override with DATABASE_PATH env var.
 */
'use strict';

const path = require('path');

const serverDir = path.resolve(__dirname, '..');
const defaultDbPath = path.join(serverDir, '..', 'data', 'yault.db');
process.env.DATABASE_PATH = process.env.DATABASE_PATH || defaultDbPath;

const db = require('../db');

function normalizeAddr(addr) {
  if (!addr || typeof addr !== 'string') return '';
  const a = addr.replace(/^0x/i, '').toLowerCase();
  return a ? '0x' + a : '';
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 4 || args.length % 2 !== 0) {
    console.error('Usage: node link-invite-wallets.js <email1> <address1> [<email2> <address2> ...]');
    console.error('Example: node server/scripts/link-invite-wallets.js w7938866@gmail.com 0x... zwanjas@gmail.com 0x...');
    process.exit(1);
  }

  const pairs = [];
  for (let i = 0; i < args.length; i += 2) {
    pairs.push({ email: args[i].trim().toLowerCase(), address: normalizeAddr(args[i + 1]) });
  }
  if (pairs.some((p) => !p.email || !p.address)) {
    console.error('Each email and address must be non-empty.');
    process.exit(1);
  }

  await db.ensureReady();

  const all = await db.accountInvites.findAll();
  const accepted = all.filter((r) => (r.status || '') === 'accepted');
  const emailToAddr = new Map(pairs.map((p) => [p.email, p.address]));

  let updated = 0;
  for (const record of accepted) {
    const email = (record.email || '').toLowerCase();
    const addr = emailToAddr.get(email);
    if (!addr) continue;
    const id = record.id;
    if (!id) continue;
    const updatedRecord = {
      ...record,
      linked_wallet_address: addr,
      updated_at: new Date().toISOString(),
    };
    await db.accountInvites.update(id, updatedRecord);
    console.log('Updated:', email, '->', addr);
    updated++;
  }

  if (updated === 0) {
    console.log('No matching accepted invites found for the given emails.');
    console.log('Accepted invites in DB:', accepted.map((r) => r.email));
  } else {
    db._saveToDisk();
    console.log('Done. Updated', updated, 'record(s).');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
