import express from "express";
const router = express.Router();
import db from "../controllers/db.js";
import bcrypt from "bcrypt";
import crypto from "crypto";
import sgMail from "@sendgrid/mail";
import { body } from "express-validator";
import { validate } from "../middleware/validate.js";
import { emailWrap, emailButton } from "../utils/emailTemplate.js";
import { BRAND } from "../config/brand.js";
import {
  buildEmailCopy,
  interpolateEmailCopy,
} from "../utils/emailLanguageCopy.js";
import { getUserEmailLanguageByEmail } from "../utils/userLanguage.js";
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ─── Ensure the reset-token columns exist ────────────────────────────────────
// (Runs once on first import; safe to call repeatedly due to IF NOT EXISTS)
const ensureColumns = async () => {
  await db.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS password_reset_token   VARCHAR(255),
      ADD COLUMN IF NOT EXISTS password_reset_expires TIMESTAMP;
  `);
};
ensureColumns().catch((e) =>
  console.error("⚠️  Could not add password-reset columns:", e.message),
);

// ─── POST /auth/forgot-password ───────────────────────────────────────────────
// Accepts: { email }
// Always returns a generic success message &mdash; do NOT reveal whether the email exists.
router.post(
  "/forgot-password",
  [
    body("email")
      .trim()
      .isEmail()
      .withMessage("A valid email address is required.")
      .normalizeEmail(),
  ],
  validate,
  async (req, res) => {
    const { email } = req.body;

    try {
      const result = await db.query(
        "SELECT id, name FROM users WHERE email = $1",
        [email.toLowerCase().trim()],
      );

      // Return the same response whether the user exists or not (prevents email enumeration)
      if (result.rows.length === 0) {
        return res.status(200).json({
          message:
            "If an account with that email exists, a password reset link has been sent.",
        });
      }

      const user = result.rows[0];
      const token = crypto.randomBytes(32).toString("hex");
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

      await db.query(
        `UPDATE users
          SET password_reset_token   = $1,
              password_reset_expires = $2
        WHERE id = $3`,
        [token, expires, user.id],
      );

      const resetLink = `${BRAND.siteUrl}/reset-password?token=${token}`;
      const resetLanguage = await getUserEmailLanguageByEmail(email);
      const resetCopy = buildEmailCopy(resetLanguage, "resetPassword");

      const msg = {
        to: email.toLowerCase().trim(),
        from: {
          email: process.env.VERIFIED_SENDER,
          name: "Fonlok",
        },
        subject: resetCopy.subject,
        html: emailWrap(
          `<h2 style="color:#0F1F3D;margin:0 0 12px;">${resetCopy.title}</h2>
          <p style="color:#475569;">${resetCopy.body(user.name)}</p>
          ${emailButton(resetLink, resetCopy.button)}
          <p style="color:#94a3b8;font-size:13px;margin-top:4px;">${resetCopy.ignore}</p>`,
          {
            footerNote: interpolateEmailCopy(resetCopy.footer, {
              year: new Date().getFullYear(),
            }),
          },
        ),
      };

      await sgMail.send(msg);

      return res.status(200).json({
        message:
          "If an account with that email exists, a password reset link has been sent.",
      });
    } catch (error) {
      console.error("Forgot-password error:", error.message);
      return res
        .status(500)
        .json({ message: "Something went wrong. Please try again." });
    }
  },
);

// ─── POST /auth/reset-password ────────────────────────────────────────────────
// Accepts: { token, password }
router.post(
  "/reset-password",
  [
    body("token")
      .trim()
      .notEmpty()
      .withMessage("Reset token is missing or invalid.")
      .isHexadecimal()
      .withMessage("Reset token format is invalid.")
      .isLength({ min: 64, max: 64 })
      .withMessage("Reset token length is invalid."),

    body("password")
      .notEmpty()
      .withMessage("New password is required.")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters."),
  ],
  validate,
  async (req, res) => {
    const { token, password } = req.body;

    try {
      const result = await db.query(
        `SELECT id, name, email
         FROM users
        WHERE password_reset_token   = $1
          AND password_reset_expires > NOW()`,
        [token],
      );

      if (result.rows.length === 0) {
        return res.status(400).json({
          message:
            "This reset link is invalid or has expired. Please request a new one.",
        });
      }

      const user = result.rows[0];
      const hashed = await bcrypt.hash(password, 12);

      await db.query(
        `UPDATE users
          SET password               = $1,
              password_reset_token   = NULL,
              password_reset_expires = NULL
        WHERE id = $2`,
        [hashed, user.id],
      );

      // Notify the user by email that their password was changed
      const passwordLanguage = await getUserEmailLanguageByEmail(user.email);
      const passwordCopy = buildEmailCopy(passwordLanguage, "resetPassword");
      const msg = {
        to: user.email,
        from: {
          email: process.env.VERIFIED_SENDER,
          name: "Fonlok",
        },
        subject: passwordCopy.changedSubject,
        html: emailWrap(
          `<h2 style="color:#0F1F3D;margin:0 0 12px;">${passwordCopy.changedTitle}</h2>
          <p style="color:#475569;">${passwordCopy.changedBody(user.name)}</p>
          <p style="color:#dc2626;font-weight:600;">${interpolateEmailCopy(
            passwordCopy.changedWarning,
            {
              sender: process.env.VERIFIED_SENDER,
            },
          )}</p>`,
          {
            footerNote: `&copy; ${new Date().getFullYear()} Fonlok &mdash; Secure Escrow Payments`,
          },
        ),
      };

      await sgMail
        .send(msg)
        .catch((e) =>
          console.error("Could not send password-changed email:", e.message),
        );

      return res.status(200).json({
        message: "Password updated successfully. You can now sign in.",
      });
    } catch (error) {
      console.error("Reset-password error:", error.message);
      return res
        .status(500)
        .json({ message: "Something went wrong. Please try again." });
    }
  },
);

export default router;
