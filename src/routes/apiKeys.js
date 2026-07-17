/**
 * apiKeys.js — Live API key management routes.
 *
 * All routes require a valid user session (authMiddleware).
 * These routes let authenticated users create, list, and revoke their
 * live API keys from the Developer dashboard.
 *
 * Routes:
 *   POST   /dev/live-keys          — create a new live key (shown once)
 *   GET    /dev/live-keys          — list all live keys (masked, never the full key)
 *   DELETE /dev/live-keys/:id      — revoke a key permanently
 */

import express from "express";
import crypto from "crypto";
import { body, param } from "express-validator";
import { validate } from "../middleware/validate.js";
import authMiddleware from "../middleware/authMiddleware.js";
import db from "../controllers/db.js";
import logger from "../utils/logger.js";

const router = express.Router();

router.use(authMiddleware);

// ── POST /dev/live-keys — create a new live API key ──────────────────────────
router.post(
  "/live-keys",
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

    try {
      // Hard cap: 5 active live keys per user.
      const countResult = await db.query(
        `SELECT COUNT(*) AS cnt FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
      if (parseInt(countResult.rows[0].cnt, 10) >= 5) {
        return res.status(429).json({
          error: "key_limit_reached",
          message:
            "You already have 5 active live API keys. Revoke an existing key before creating a new one.",
        });
      }

      // Generate: sk_live_ (8 chars) + 32 random lowercase hex chars = 40 chars total.
      const rawKey = "sk_live_" + crypto.randomBytes(16).toString("hex");
      const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
      // Prefix stored for display only (first 16 chars: "sk_live_a1b2c3d4").
      const keyPrefix = rawKey.slice(0, 16);

      const result = await db.query(
        `INSERT INTO api_keys (user_id, key_prefix, key_hash, label)
         VALUES ($1, $2, $3, $4)
         RETURNING id, key_prefix, label, created_at`,
        [userId, keyPrefix, keyHash, label],
      );

      const row = result.rows[0];
      logger.info("Live API key created", { userId, keyId: row.id, label });

      return res.status(201).json({
        id: row.id,
        key: rawKey, // Returned exactly once. Copy it immediately.
        key_prefix: row.key_prefix,
        label: row.label,
        created_at: row.created_at,
        _note: "Store this key securely. It will not be shown again.",
      });
    } catch (err) {
      logger.error("Failed to create live API key", {
        error: err.message,
        userId,
      });
      return res
        .status(500)
        .json({ error: "server_error", message: "Failed to create key." });
    }
  },
);

// ── GET /dev/live-keys — list all live keys for the authenticated user ────────
router.get("/live-keys", async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await db.query(
      `SELECT id, key_prefix, label, created_at, last_used_at,
              request_count, revoked_at
       FROM api_keys
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId],
    );
    return res.json({ data: result.rows });
  } catch (err) {
    logger.error("Failed to list live API keys", { error: err.message });
    return res
      .status(500)
      .json({ error: "server_error", message: "Failed to retrieve keys." });
  }
});

// ── DELETE /dev/live-keys/:id — revoke a live key permanently ────────────────
router.delete(
  "/live-keys/:id",
  [param("id").isInt({ min: 1 }).withMessage("id must be a positive integer.")],
  validate,
  async (req, res) => {
    const userId = req.user.id;
    const keyId = parseInt(req.params.id, 10);

    try {
      const result = await db.query(
        `UPDATE api_keys
         SET revoked_at = NOW()
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
         RETURNING id, label`,
        [keyId, userId],
      );
      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "not_found",
          message: "No active live API key found with that id on your account.",
        });
      }
      logger.info("Live API key revoked", { userId, keyId });
      return res.json({ id: keyId, revoked: true });
    } catch (err) {
      logger.error("Failed to revoke live API key", { error: err.message });
      return res
        .status(500)
        .json({ error: "server_error", message: "Failed to revoke key." });
    }
  },
);

export default router;
