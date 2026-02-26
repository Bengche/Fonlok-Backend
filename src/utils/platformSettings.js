/**
 * platformSettings.js
 *
 * Cached reader/writer for the platform_settings key-value table.
 * Results are cached in-process for CACHE_TTL ms to avoid hitting the DB on
 * every incoming request while still picking up changes within ~10 seconds.
 */

import db from "../controllers/db.js";

const CACHE_TTL = 10_000; // 10 seconds

const DEFAULTS = {
  maintenance_mode: "false",
  payments_blocked: "false",
  payouts_blocked: "false",
};

let _cache = null;
let _cacheExpiry = 0;

/**
 * Returns an object with all platform setting keys as booleans.
 * Uses the in-process cache when available.
 */
export async function getSettings() {
  const now = Date.now();
  if (_cache && now < _cacheExpiry) return _cache;

  const result = await db.query(
    "SELECT key, value FROM platform_settings",
  );

  const settings = { ...DEFAULTS };
  for (const row of result.rows) {
    settings[row.key] = row.value;
  }

  _cache = settings;
  _cacheExpiry = now + CACHE_TTL;
  return settings;
}

/**
 * Upserts a single setting and busts the cache immediately.
 * @param {string} key
 * @param {boolean} value
 */
export async function setSetting(key, value) {
  await db.query(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, String(value)],
  );
  invalidateCache();
}

/** Forces the next getSettings() call to hit the database. */
export function invalidateCache() {
  _cache = null;
  _cacheExpiry = 0;
}

/** Convenience: maps string 'true'/'false' stored values to real booleans. */
export function bool(settings, key) {
  return settings[key] === "true";
}
