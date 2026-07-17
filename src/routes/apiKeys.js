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
import dotenv from "dotenv";
import sgMail from "@sendgrid/mail";
import { body, param } from "express-validator";
import { validate } from "../middleware/validate.js";
import authMiddleware from "../middleware/authMiddleware.js";
import db from "../controllers/db.js";
import logger from "../utils/logger.js";
import { emailWrap, emailButton } from "../utils/emailTemplate.js";
import { BRAND } from "../config/brand.js";

dotenv.config();
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const router = express.Router();

router.use(authMiddleware);

// ── POST /dev/live-keys — apply for a new live API key ───────────────────────
// Users must supply business context. The key is created immediately but
// starts as pending — it will not work until an admin approves it.
router.post(
  "/live-keys",
  [
    body("label")
      .trim()
      .notEmpty()
      .withMessage("label is required.")
      .isLength({ max: 80 })
      .withMessage("label must be 80 characters or fewer."),
    body("company_name")
      .trim()
      .notEmpty()
      .withMessage("company_name is required.")
      .isLength({ max: 200 })
      .withMessage("company_name must be 200 characters or fewer."),
    body("website_url")
      .trim()
      .notEmpty()
      .withMessage("website_url is required.")
      .isURL({ require_protocol: true, protocols: ["http", "https"] })
      .withMessage(
        "website_url must be a valid URL starting with http:// or https://.",
      )
      .isLength({ max: 500 })
      .withMessage("website_url must be 500 characters or fewer."),
    body("use_case")
      .trim()
      .notEmpty()
      .withMessage("use_case is required.")
      .isLength({ min: 20, max: 1000 })
      .withMessage("use_case must be between 20 and 1000 characters."),
  ],
  validate,
  async (req, res) => {
    const userId = req.user.id;
    const { label, company_name, website_url, use_case } = req.body;

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
        `INSERT INTO api_keys
           (user_id, key_prefix, key_hash, label, company_name, website_url, use_case)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, key_prefix, label, created_at`,
        [userId, keyPrefix, keyHash, label, company_name, website_url, use_case],
      );

      const row = result.rows[0];
      logger.info("Live API key application submitted", {
        userId,
        keyId: row.id,
        label,
        company_name,
      });

      // Notify admin so the request can be reviewed promptly.
      try {
        const userResult = await db.query(
          "SELECT email, name FROM users WHERE id = $1",
          [userId],
        );
        const applicant = userResult.rows[0] || {};
        const adminEmail = process.env.ADMIN_EMAIL || BRAND.supportEmail;
        await sgMail.send({
          to: adminEmail,
          from: { name: BRAND.name, email: BRAND.supportEmail },
          subject: `New live API key request — ${company_name}`,
          html: emailWrap(`
            <h2 style="margin:0 0 8px;color:#0f172a;font-size:22px;font-weight:800;">New API key request</h2>
            <p style="margin:0 0 18px;color:#475569;line-height:1.7;">
              A user has applied for a live API key and is waiting for approval.
            </p>
            <table style="width:100%;border-collapse:collapse;font-size:14px;border:1px solid rgba(15,23,42,0.08);border-radius:12px;overflow:hidden;margin-bottom:18px;">
              <tr><td style="padding:10px 14px;background:#f8fafc;color:#64748b;font-weight:700;width:34%;">Applicant</td><td style="padding:10px 14px;color:#0f172a;">${applicant.name || "—"} (${applicant.email || "—"})</td></tr>
              <tr><td style="padding:10px 14px;background:#f8fafc;color:#64748b;font-weight:700;">Company</td><td style="padding:10px 14px;color:#0f172a;font-weight:700;">${company_name}</td></tr>
              <tr><td style="padding:10px 14px;background:#f8fafc;color:#64748b;font-weight:700;">Website</td><td style="padding:10px 14px;color:#0f172a;"><a href="${website_url}" style="color:#2563eb;">${website_url}</a></td></tr>
              <tr><td style="padding:10px 14px;background:#f8fafc;color:#64748b;font-weight:700;">Use case</td><td style="padding:10px 14px;color:#0f172a;">${use_case}</td></tr>
              <tr><td style="padding:10px 14px;background:#f8fafc;color:#64748b;font-weight:700;">Key label</td><td style="padding:10px 14px;color:#0f172a;">${label}</td></tr>
              <tr><td style="padding:10px 14px;background:#f8fafc;color:#64748b;font-weight:700;">Key ID</td><td style="padding:10px 14px;color:#0f172a;">#${row.id}</td></tr>
            </table>
            ${emailButton("Approve in admin panel", (process.env.NEXT_PUBLIC_APP_URL || "https://fonlok.com") + "/admin/live-keys")}
          `),
        });
      } catch (emailErr) {
        logger.warn("Failed to send admin API key request notification", {
          error: emailErr.message,
        });
      }

      return res.status(201).json({
        id: row.id,
        key: rawKey, // Returned exactly once. Copy it immediately.
        key_prefix: row.key_prefix,
        label: row.label,
        status: "pending_approval",
        created_at: row.created_at,
        _note:
          "Store this key securely. It will not be shown again. Your key is pending admin approval — you will be emailed once it is activated.",
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
      `SELECT id, key_prefix, label, company_name, website_url, use_case,
              approved_at, rejected_at, rejection_reason,
              created_at, last_used_at, request_count, revoked_at
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
