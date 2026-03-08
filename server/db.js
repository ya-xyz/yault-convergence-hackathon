'use strict';

// Database backend selector:
// - Use Postgres only when DB_BACKEND=postgres (explicit cutover switch).
// - Otherwise fallback to SQLite/sql.js file backend.
const usePostgres =
  String(process.env.DB_BACKEND || '').trim().toLowerCase() === 'postgres' &&
  String(process.env.DATABASE_URL || '').trim();

module.exports = usePostgres
  ? require('./db-postgres')
  : require('./db-sqlite');
