/**
 * user.js — account self-management routes
 *
 * All routes require the user to be authenticated (authMiddleware).
 *
 *   PATCH  /user/update-name
 *   PATCH  /user/update-email
 *   PATCH  /user/update-phone
 *   PATCH  /user/update-profile-picture
 *   PATCH  /user/change-password
 *   DELETE /user/delete-account
 */

import express from "express";
const router = express.Router();
import db from "../controllers/db.js";
import bcrypt from "bcrypt";
import multer from "multer";
import authMiddleware from "../middleware/authMiddleware.js";
import { body } from "express-validator";
import { validate } from "../middleware/validate.js";
import {
  uploadToCloudinary,
  deleteFromCloudinary,
  publicIdFromUrl,
} from "../utils/cloudinary.js";
import {
  clearAuthCookie,
  listUserSessions,
  revokeOtherUserSessions,
  revokeUserSession,
} from "../utils/sessionSecurity.js";
import dotenv from "dotenv";
dotenv.config();

const saltRounds = 10;

db.query(
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_dismissed BOOLEAN NOT NULL DEFAULT false",
).catch((e) =>
  console.error("⚠️  onboarding_dismissed migration error:", e.message),
);

db.query(
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_email_language VARCHAR(5) NOT NULL DEFAULT 'en'",
).catch((e) =>
  console.error("⚠️  preferred_email_language migration error:", e.message),
);

db.query(
  `ALTER TABLE users
     ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT false,
     ADD COLUMN IF NOT EXISTS login_otp_hash TEXT,
     ADD COLUMN IF NOT EXISTS login_otp_expires TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS login_otp_attempts INTEGER NOT NULL DEFAULT 0`,
).catch((e) => console.error("⚠️  two_factor migration error:", e.message));

// ── Multer — profile picture uploads (memory storage → Cloudinary) ──────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only image files (JPEG, PNG, WebP, GIF) are allowed."));
  },
});

router.get("/sessions", authMiddleware, async (req, res) => {
  try {
    const sessions = await listUserSessions(req.user.id, req.user.sid);
    return res.status(200).json({ sessions, currentSid: req.user.sid || null });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ message: "Failed to load active sessions." });
  }
});

router.post("/sessions/revoke-others", authMiddleware, async (req, res) => {
  try {
    if (!req.user.sid) {
      return res.status(400).json({
        message: "Please sign in again before managing active sessions.",
      });
    }

    const revokedCount = await revokeOtherUserSessions(
      req.user.id,
      req.user.sid,
    );
    return res.status(200).json({
      ok: true,
      revokedCount,
      message:
        revokedCount > 0
          ? "Other active sessions were revoked."
          : "No other active sessions were found.",
    });
  } catch (err) {
    console.error(err.message);
    return res
      .status(500)
      .json({ message: "Failed to revoke other sessions." });
  }
});

router.delete("/sessions/:sid", authMiddleware, async (req, res) => {
  try {
    const sid = String(req.params.sid || "").trim();
    if (!sid) {
      return res.status(400).json({ message: "A session ID is required." });
    }

    const revoked = await revokeUserSession(req.user.id, sid);
    if (!revoked) {
      return res.status(404).json({ message: "Session not found." });
    }

    if (sid === req.user.sid) {
      clearAuthCookie(res);
    }

    return res.status(200).json({ ok: true, message: "Session revoked." });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ message: "Failed to revoke session." });
  }
});

// ── PATCH /user/update-name ──────────────────────────────────────────────────
router.patch(
  "/update-name",
  authMiddleware,
  [
    body("name")
      .trim()
      .notEmpty()
      .withMessage("Name is required.")
      .isLength({ max: 100 })
      .withMessage("Name must be 100 characters or fewer."),
  ],
  validate,
  async (req, res) => {
    const userId = req.user.id;
    const { name } = req.body;
    try {
      const result = await db.query(
        "UPDATE users SET name = $1 WHERE id = $2 RETURNING name",
        [name, userId],
      );
      if (result.rows.length === 0)
        return res.status(404).json({ message: "User not found." });
      return res.status(200).json({ ok: true, name: result.rows[0].name });
    } catch (err) {
      console.error(err.message);
      return res.status(500).json({ message: "Failed to update name." });
    }
  },
);

// ── PATCH /user/update-email ─────────────────────────────────────────────────
router.patch(
  "/update-email",
  authMiddleware,
  [
    body("email")
      .trim()
      .isEmail()
      .withMessage("A valid email address is required.")
      .normalizeEmail(),
  ],
  validate,
  async (req, res) => {
    const userId = req.user.id;
    const { email } = req.body;
    try {
      // Check not already taken by another account
      const taken = await db.query(
        "SELECT id FROM users WHERE email = $1 AND id != $2",
        [email, userId],
      );
      if (taken.rows.length > 0)
        return res.status(409).json({
          message: "That email is already in use by another account.",
        });

      const result = await db.query(
        "UPDATE users SET email = $1 WHERE id = $2 RETURNING email",
        [email, userId],
      );
      if (result.rows.length === 0)
        return res.status(404).json({ message: "User not found." });
      return res.status(200).json({ ok: true, email: result.rows[0].email });
    } catch (err) {
      console.error(err.message);
      return res.status(500).json({ message: "Failed to update email." });
    }
  },
);

// ── PATCH /user/update-phone ─────────────────────────────────────────────────
router.patch(
  "/update-phone",
  authMiddleware,
  [
    body("phone")
      .trim()
      .notEmpty()
      .withMessage("Phone number is required.")
      .matches(/^237[62]\d{8}$/)
      .withMessage(
        "Phone must start with 237 followed by a valid Cameroonian number (12 digits total, e.g. 2376XXXXXXXX).",
      ),
  ],
  validate,
  async (req, res) => {
    const userId = req.user.id;
    const { phone } = req.body;
    try {
      await db.query("UPDATE users SET phone = $1 WHERE id = $2", [
        phone,
        userId,
      ]);
      return res.status(200).json({ ok: true, phone });
    } catch (err) {
      console.error(err.message);
      return res
        .status(500)
        .json({ message: "Failed to update phone number." });
    }
  },
);
// ── PATCH /user/update-email-language ───────────────────────────────────────
router.patch(
  "/update-email-language",
  authMiddleware,
  [
    body("preferred_email_language")
      .trim()
      .notEmpty()
      .isIn(["en", "fr"])
      .withMessage("Language must be English or French."),
  ],
  validate,
  async (req, res) => {
    const userId = req.user.id;
    const { preferred_email_language } = req.body;
    try {
      const result = await db.query(
        "UPDATE users SET preferred_email_language = $1 WHERE id = $2 RETURNING preferred_email_language",
        [preferred_email_language, userId],
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ message: "User not found." });
      }
      return res.status(200).json({
        ok: true,
        preferred_email_language: result.rows[0].preferred_email_language,
      });
    } catch (err) {
      console.error(err.message);
      return res
        .status(500)
        .json({ message: "Failed to update email language." });
    }
  },
);

// ── GET /user/two-factor ────────────────────────────────────────────────────
router.get("/two-factor", authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT two_factor_enabled FROM users WHERE id = $1",
      [req.user.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }
    return res.status(200).json({
      two_factor_enabled: Boolean(result.rows[0].two_factor_enabled),
    });
  } catch (err) {
    console.error(err.message);
    return res
      .status(500)
      .json({ message: "Failed to load security settings." });
  }
});

// ── PATCH /user/two-factor ──────────────────────────────────────────────────
router.patch(
  "/two-factor",
  authMiddleware,
  [
    body("enabled")
      .notEmpty()
      .isBoolean()
      .withMessage("Two-factor value must be true or false.")
      .toBoolean(),
  ],
  validate,
  async (req, res) => {
    try {
      const userId = req.user.id;
      const enabled = Boolean(req.body.enabled);

      const result = await db.query(
        `UPDATE users
            SET two_factor_enabled = $1,
                login_otp_hash = NULL,
                login_otp_expires = NULL,
                login_otp_attempts = 0
          WHERE id = $2
      RETURNING two_factor_enabled`,
        [enabled, userId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ message: "User not found." });
      }

      return res.status(200).json({
        ok: true,
        two_factor_enabled: Boolean(result.rows[0].two_factor_enabled),
      });
    } catch (err) {
      console.error(err.message);
      return res
        .status(500)
        .json({ message: "Failed to update 2FA settings." });
    }
  },
);

// ── PATCH /user/update-profile-picture ──────────────────────────────────────
router.patch(
  "/update-profile-picture",
  authMiddleware,
  upload.single("image"),
  async (req, res) => {
    const userId = req.user.id;

    if (!req.file) {
      return res.status(400).json({ message: "No image file provided." });
    }

    try {
      // Fetch current picture URL so we can delete the old one from Cloudinary
      const current = await db.query(
        "SELECT profilepicture FROM users WHERE id = $1",
        [userId],
      );

      // Upload new image to Cloudinary
      const { url: cloudinaryUrl, publicId } = await uploadToCloudinary(
        req.file.buffer,
        {
          folder: "fonlok/avatars",
          resource_type: "image",
          // Overwrite keyed by user id so each user has exactly one avatar stored
          public_id: `user_${userId}`,
          overwrite: true,
          invalidate: true,
        },
      );

      // Save full Cloudinary URL to DB
      await db.query("UPDATE users SET profilepicture = $1 WHERE id = $2", [
        cloudinaryUrl,
        userId,
      ]);

      // Delete old picture from Cloudinary if it was a different Cloudinary asset
      const oldUrl = current.rows[0]?.profilepicture;
      const oldPublicId = publicIdFromUrl(oldUrl);
      if (oldPublicId && oldPublicId !== publicId) {
        await deleteFromCloudinary(oldPublicId);
      }

      return res.status(200).json({ ok: true, profilepicture: cloudinaryUrl });
    } catch (err) {
      console.error(err.message);
      return res
        .status(500)
        .json({ message: "Failed to update profile picture." });
    }
  },
);

// ── PATCH /user/change-password ──────────────────────────────────────────────
router.patch(
  "/change-password",
  authMiddleware,
  [
    body("current_password")
      .notEmpty()
      .withMessage("Current password is required."),
    body("new_password")
      .isLength({ min: 8 })
      .withMessage("New password must be at least 8 characters."),
  ],
  validate,
  async (req, res) => {
    const userId = req.user.id;
    const { current_password, new_password } = req.body;
    try {
      const result = await db.query(
        "SELECT password FROM users WHERE id = $1",
        [userId],
      );
      if (result.rows.length === 0)
        return res.status(404).json({ message: "User not found." });

      const match = await bcrypt.compare(
        current_password,
        result.rows[0].password,
      );
      if (!match)
        return res
          .status(401)
          .json({ message: "Current password is incorrect." });

      const hashed = await bcrypt.hash(new_password, saltRounds);
      await db.query("UPDATE users SET password = $1 WHERE id = $2", [
        hashed,
        userId,
      ]);
      return res
        .status(200)
        .json({ ok: true, message: "Password changed successfully." });
    } catch (err) {
      console.error(err.message);
      return res.status(500).json({ message: "Failed to change password." });
    }
  },
);

// ── DELETE /user/delete-account ──────────────────────────────────────────────
// Requires current password as confirmation.
// Deletes all user data: invoices, guests, reviews, notifications, chat messages, etc.
router.delete(
  "/delete-account",
  authMiddleware,
  [
    body("password")
      .notEmpty()
      .withMessage("Password confirmation is required."),
  ],
  validate,
  async (req, res) => {
    const userId = req.user.id;
    const { password } = req.body;
    try {
      // 1. Verify password
      const userResult = await db.query(
        "SELECT password FROM users WHERE id = $1",
        [userId],
      );
      if (userResult.rows.length === 0)
        return res.status(404).json({ message: "User not found." });

      const match = await bcrypt.compare(password, userResult.rows[0].password);
      if (!match)
        return res
          .status(401)
          .json({ message: "Incorrect password. Account not deleted." });

      // 2. Block deletion if the user has funds held in escrow
      //    (paid or delivered invoices that haven't been settled)
      const escrowCheck = await db.query(
        `SELECT COUNT(*) AS cnt FROM invoices
         WHERE userid = $1 AND status IN ('paid', 'delivered')`,
        [userId],
      );
      if (parseInt(escrowCheck.rows[0].cnt) > 0) {
        return res.status(400).json({
          message:
            "Your account has active transactions in escrow. Please complete or resolve all paid/delivered invoices before deleting your account.",
        });
      }

      // 3. Delete the user — rely on ON DELETE CASCADE for related rows.
      //    If your DB doesn't have cascade set up, delete in order below.
      await db.query("DELETE FROM notifications WHERE userid = $1", [userId]);
      await db.query(
        "DELETE FROM reviews WHERE reviewer_userid = $1 OR seller_userid = $1",
        [userId],
      );
      await db.query("DELETE FROM push_subscriptions WHERE userid = $1", [
        userId,
      ]);
      await db.query("DELETE FROM users WHERE id = $1", [userId]);

      // 4. Clear the auth cookie
      clearAuthCookie(res);
      return res.status(200).json({
        ok: true,
        message: "Your account has been permanently deleted.",
      });
    } catch (err) {
      console.error(err.message);
      return res
        .status(500)
        .json({ message: "Failed to delete account. Please try again." });
    }
  },
);

// GET /user/me — returns the authenticated user's email
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const result = await db.query("SELECT email FROM users WHERE id = $1", [
      req.user.id,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }
    return res.status(200).json({ email: result.rows[0].email });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ message: "Failed to fetch user info." });
  }
});

// GET /user/onboarding-checklist — progress for first-time onboarding
router.get("/onboarding-checklist", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const [userResult, invoiceResult, viewedResult] = await Promise.all([
      db.query(
        "SELECT profilepicture, kyc_status, onboarding_dismissed FROM users WHERE id = $1",
        [userId],
      ),
      db.query(
        "SELECT COUNT(*)::int AS count FROM invoices WHERE userid = $1",
        [userId],
      ),
      db.query(
        "SELECT COUNT(*)::int AS count FROM invoices WHERE userid = $1 AND viewed_at IS NOT NULL",
        [userId],
      ),
    ]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    const user = userResult.rows[0];
    const hasProfilePhoto = Boolean(user.profilepicture);
    const hasCreatedInvoice = Number(invoiceResult.rows[0]?.count || 0) > 0;
    const hasInvitedClient = Number(viewedResult.rows[0]?.count || 0) > 0;
    const hasCompletedKyc = user.kyc_status === "approved";

    const steps = [
      {
        key: "photo",
        completed: hasProfilePhoto,
        href: "/settings",
      },
      {
        key: "invoice",
        completed: hasCreatedInvoice,
        href: "/dashboard?action=create",
      },
      {
        key: "invite",
        completed: hasInvitedClient,
        href: "/dashboard",
      },
      {
        key: "kyc",
        completed: hasCompletedKyc,
        href: "/kyc",
      },
    ];

    const completedCount = steps.filter((s) => s.completed).length;
    const totalCount = steps.length;
    const allCompleted = completedCount === totalCount;

    return res.status(200).json({
      steps,
      completedCount,
      totalCount,
      allCompleted,
      dismissed: Boolean(user.onboarding_dismissed),
    });
  } catch (err) {
    console.error(err.message);
    return res
      .status(500)
      .json({ message: "Failed to load onboarding checklist." });
  }
});

// POST /user/onboarding-checklist/dismiss — persist one-time dismissal
router.post(
  "/onboarding-checklist/dismiss",
  authMiddleware,
  async (req, res) => {
    try {
      const userId = req.user.id;

      const result = await db.query(
        "UPDATE users SET onboarding_dismissed = true WHERE id = $1 RETURNING id",
        [userId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ message: "User not found." });
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error(err.message);
      return res
        .status(500)
        .json({ message: "Failed to dismiss onboarding checklist." });
    }
  },
);

export default router;
