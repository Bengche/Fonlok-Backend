/**
 * sandboxKeys.js — Sandbox API key management routes.
 *
 * All routes require a valid user session (authMiddleware).
 * These routes let authenticated users create, list, and revoke their
 * sandbox API keys from the Developer dashboard.
 *
 * Routes:
 *   POST   /dev/keys          — create a new sandbox key (shown once)
 *   GET    /dev/keys          — list all keys (masked, never the full key)
 *   DELETE /dev/keys/:id      — revoke a key permanently
 */

import express from "express";
import crypto from "crypto";
import { body, param } from "express-validator";
import { validate } from "../middleware/validate.js";
import authMiddleware from "../middleware/authMiddleware.js";
import db from "../controllers/db.js";
import logger from "../utils/logger.js";

const router = express.Router();

// Every route here requires an authenticated user session.
router.use(authMiddleware);

// ── POST /dev/keys — create a new sandbox API key ────────────────────────────
router.post(
  "/keys",
  [
    body("label")
      .trim()
      .notEmpty()
      .withMessage("label is required.")
      .isLength({ max: 80 })
      .withMessage("label must be 80 characters or fewer."),
  ],
  validate,
  async (req, res) => {
    const userId = req.user.id;
    const { label } = req.body;

    // Enforce a hard cap of 5 active keys per user.
    try {
      const countResult = await db.query(
        `SELECT COUNT(*) AS cnt FROM sandbox_api_keys WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
      if (parseInt(countResult.rows[0].cnt, 10) >= 5) {
        return res.status(429).json({
          error: "key_limit_reached",
          message:
            "You already have 5 active sandbox keys. Revoke an existing key before creating a new one.",
        });
      }

      // Generate: sk_test_ (8 chars) + 32 random lowercase hex chars = 40 chars total.
      const rawKey = "sk_test_" + crypto.randomBytes(16).toString("hex");
      const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
      // Prefix stored for display only (first 16 chars: "sk_test_a1b2c3d4").
      const keyPrefix = rawKey.slice(0, 16);

      const result = await db.query(
        `INSERT INTO sandbox_api_keys (user_id, key_prefix, key_hash, label)
         VALUES ($1, $2, $3, $4)
         RETURNING id, key_prefix, label, created_at`,
        [userId, keyPrefix, keyHash, label],
      );

      const row = result.rows[0];
      return res.status(201).json({
        id: row.id,
        key: rawKey, // Returned exactly once. The client must copy it immediately.
        key_prefix: row.key_prefix,
        label: row.label,
        created_at: row.created_at,
        _note: "Store this key securely. It will not be shown again.",
      });
    } catch (err) {
      logger.error("Failed to create sandbox API key", {
        error: err.message,
        userId,
      });
      return res
        .status(500)
        .json({ error: "server_error", message: "Failed to create key." });
    }
  },
);

// ── GET /dev/keys — list all keys for the authenticated user ────────────────
router.get("/keys", async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await db.query(
      `SELECT id, key_prefix, label, created_at, last_used_at,
              request_count, revoked_at
       FROM sandbox_api_keys
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId],
    );
    return res.json({ keys: result.rows });
  } catch (err) {
    logger.error("Failed to list sandbox keys", { error: err.message, userId });
    return res
      .status(500)
      .json({ error: "server_error", message: "Failed to retrieve keys." });
  }
});

// ── DELETE /dev/keys/:id — revoke a sandbox API key ─────────────────────────
router.delete(
  "/keys/:id",
  [param("id").isInt({ min: 1 }).withMessage("Invalid key ID.")],
  validate,
  async (req, res) => {
    const userId = req.user.id;
    const keyId = parseInt(req.params.id, 10);

    try {
      const result = await db.query(
        `UPDATE sandbox_api_keys
         SET revoked_at = NOW()
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
         RETURNING id`,
        [keyId, userId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "not_found",
          message:
            "Key not found, already revoked, or does not belong to your account.",
        });
      }

      return res.json({ success: true, message: "Key revoked successfully." });
    } catch (err) {
      logger.error("Failed to revoke sandbox key", {
        error: err.message,
        userId,
        keyId,
      });
      return res
        .status(500)
        .json({ error: "server_error", message: "Failed to revoke key." });
    }
  },
);

export default router;
