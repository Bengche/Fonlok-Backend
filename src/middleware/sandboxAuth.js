/**
 * sandboxAuth — Bearer-token middleware for all /sandbox/* routes.
 *
 * Expects: Authorization: Bearer sk_test_<32 lowercase hex chars>
 *
 * The full key is never stored. Only a SHA-256 hash is kept in the
 * sandbox_api_keys table, making the DB safe to inspect without
 * exposing usable credentials.
 *
 * On success: attaches req.sandboxKey = { id, user_id, label } and calls next().
 * On failure: returns a structured JSON error with an appropriate HTTP status code.
 */

import crypto from "crypto";
import db from "../controllers/db.js";
import logger from "../utils/logger.js";

export async function sandboxAuth(req, res, next) {
  const authHeader = req.headers["authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "missing_api_key",
      message:
        "No API key provided. Include your sandbox key in the request header: Authorization: Bearer sk_test_...",
    });
  }

  const rawKey = authHeader.slice(7).trim();

  // Validate the key format before hitting the DB.
  // sk_test_ = 8 chars, 32 lowercase hex chars = 40 total.
  if (!/^sk_test_[0-9a-f]{32}$/.test(rawKey)) {
    return res.status(401).json({
      error: "invalid_api_key_format",
      message:
        "Sandbox keys are exactly 40 characters and begin with sk_test_. Find your key in the Developer dashboard.",
    });
  }

  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

  try {
    const result = await db.query(
      `SELECT id, user_id, label, revoked_at
       FROM sandbox_api_keys
       WHERE key_hash = $1`,
      [keyHash],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "invalid_api_key",
        message:
          "The provided API key does not match any sandbox key on record.",
      });
    }

    const row = result.rows[0];

    if (row.revoked_at) {
      return res.status(401).json({
        error: "revoked_api_key",
        message:
          "This sandbox API key has been revoked. Create a new one in the Developer dashboard.",
      });
    }

    // Update usage stats asynchronously — never block the request for this.
    db.query(
      `UPDATE sandbox_api_keys
       SET last_used_at = NOW(), request_count = request_count + 1
       WHERE id = $1`,
      [row.id],
    ).catch((e) =>
      logger.warn("Sandbox key usage update failed", {
        error: e.message,
        keyId: row.id,
      }),
    );

    req.sandboxKey = { id: row.id, user_id: row.user_id, label: row.label };
    next();
  } catch (err) {
    logger.error("Sandbox auth DB error", { error: err.message });
    return res.status(500).json({
      error: "auth_error",
      message: "Authentication check failed. Please try again.",
    });
  }
}
