/**
 * apiKeyAuth — Bearer-token middleware for all /v1/* production API routes.
 *
 * Key format : sk_live_<32 lowercase hex chars>  (40 chars total)
 * The full key is NEVER stored. Only a SHA-256 hash is kept in the
 * api_keys table, making the database safe to audit without exposing
 * usable credentials.
 *
 * On success : attaches req.apiKey = { id, user_id, label } and calls next().
 * On failure : returns a structured JSON error with an appropriate HTTP status.
 *
 * Hardening:
 *  - Key is hashed (SHA-256) before DB lookup — raw key never reaches the DB.
 *  - Key format validated with a strict regex before any DB hit.
 *  - Revoked keys are rejected even if the hash matches.
 *  - Usage stats updated asynchronously — the request is never blocked for it.
 */

import crypto from "crypto";
import db from "../controllers/db.js";
import logger from "../utils/logger.js";

export async function apiKeyAuth(req, res, next) {
  const authHeader = req.headers["authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "missing_api_key",
      message:
        "No API key provided. Include your live key in the request header: Authorization: Bearer sk_live_...",
    });
  }

  const rawKey = authHeader.slice(7).trim();

  // Validate format before hitting the DB. sk_live_ = 8 chars + 32 hex = 40 total.
  if (!/^sk_live_[0-9a-f]{32}$/.test(rawKey)) {
    return res.status(401).json({
      error: "invalid_api_key_format",
      message:
        "Live API keys are exactly 40 characters and begin with sk_live_. Find your key in the Fonlok Developer dashboard.",
    });
  }

  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

  try {
    const result = await db.query(
      `SELECT id, user_id, label, revoked_at
       FROM api_keys
       WHERE key_hash = $1`,
      [keyHash],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "invalid_api_key",
        message: "The provided API key does not match any live key on record.",
      });
    }

    const row = result.rows[0];

    if (row.revoked_at) {
      return res.status(401).json({
        error: "revoked_api_key",
        message:
          "This API key has been revoked. Create a new one in the Fonlok Developer dashboard.",
      });
    }

    // Update usage stats asynchronously — never block the request for this.
    db.query(
      `UPDATE api_keys
       SET last_used_at = NOW(), request_count = request_count + 1
       WHERE id = $1`,
      [row.id],
    ).catch((e) =>
      logger.warn("Live API key usage update failed", {
        error: e.message,
        keyId: row.id,
      }),
    );

    req.apiKey = { id: row.id, user_id: row.user_id, label: row.label };
    next();
  } catch (err) {
    logger.error("Live API key auth DB error", { error: err.message });
    return res.status(500).json({
      error: "auth_error",
      message: "Authentication check failed. Please try again.",
    });
  }
}
