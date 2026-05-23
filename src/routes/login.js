import express from "express";
const router = express.Router();
import db from "../controllers/db.js";
import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import sgMail from "@sendgrid/mail";
import { body } from "express-validator";
import { validate } from "../middleware/validate.js";
import logger from "../utils/logger.js";
import { buildEmailCopy } from "../utils/emailLanguageCopy.js";
import { getUserEmailLanguageById } from "../utils/userLanguage.js";
import {
  clearPendingLoginCookie,
  issueUserAuthSession,
  setPendingLoginCookie,
} from "../utils/sessionSecurity.js";

router.use(cookieParser());

if (process.env.SENDGRID_API_KEY?.startsWith("SG.")) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

db.query(
  `
  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS login_otp_hash TEXT,
    ADD COLUMN IF NOT EXISTS login_otp_expires TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS login_otp_attempts INTEGER NOT NULL DEFAULT 0
`,
).catch((e) => console.error("⚠️  login OTP migration error:", e.message));

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function maskEmail(email) {
  const normalized = String(email || "").trim();
  const [local, domain] = normalized.split("@");
  if (!local || !domain) return normalized;
  return `${local.slice(0, 2)}***@${domain}`;
}

async function clearOtpChallenge(userId) {
  await db.query(
    `UPDATE users
        SET login_otp_hash = NULL,
            login_otp_expires = NULL,
            login_otp_attempts = 0
      WHERE id = $1`,
    [userId],
  );
}

async function sendLoginOtpEmail(user, otp) {
  const language = await getUserEmailLanguageById(user.id);
  const copy = buildEmailCopy(language, "loginOtp");
  const expiresMinutes = 10;

  const html = `
    <div style="text-align:left;">
      <h2 style="color:#0F1F3D;margin:0 0 12px;">${copy.title}</h2>
      <p style="color:#475569;line-height:1.7;">${copy.body(user.name)}</p>
      <div style="margin:20px 0;padding:18px 20px;border-radius:14px;background:linear-gradient(135deg, rgba(15,31,61,0.04), rgba(245,158,11,0.16));border:1px solid rgba(15,31,61,0.12);text-align:center;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin-bottom:10px;">${copy.codeLabel}</div>
        <div style="font-size:32px;letter-spacing:0.22em;font-weight:800;color:#0F1F3D;font-family:monospace;">${otp}</div>
        <div style="margin-top:10px;font-size:12px;color:#64748b;">Expires in ${expiresMinutes} minutes</div>
      </div>
      <p style="color:#64748b;font-size:13px;line-height:1.6;">${copy.footer}</p>
    </div>
  `;

  await sgMail.send({
    to: user.email,
    from: {
      email: process.env.VERIFIED_SENDER,
      name: "Fonlok",
    },
    subject: copy.subject,
    html,
  });
}

router.post(
  "/login",
  [
    body("email")
      .trim()
      .notEmpty()
      .withMessage("Email or username is required."),

    body("password").notEmpty().withMessage("Password is required."),
  ],
  validate,
  async (req, res) => {
    const { email, password } = req.body;
    const normalizedEmail = email.toLowerCase();
    try {
      const result = await db.query(
        "SELECT id, name, username, email, password, two_factor_enabled, email_verified FROM users WHERE email = $1 OR username = $2",
        [normalizedEmail, email],
      );
      if (result.rows.length === 0) {
        // Generic message — do NOT reveal whether the email/username exists.
        // A 401 (not 404) prevents account enumeration via status code.
        return res.status(401).json({ message: "Invalid email or password." });
      }
      const user = result.rows[0];

      // Block login for unverified accounts
      if (!user.email_verified) {
        return res.status(403).json({
          code: "EMAIL_NOT_VERIFIED",
          message:
            "Please verify your email address before signing in. Check your inbox for the verification code.",
          email: user.email,
        });
      }

      const userPassword = user.password;
      const isMatch = await bcrypt.compare(password, userPassword);
      if (isMatch) {
        if (user.two_factor_enabled) {
          const otp = generateOtp();
          const hashedOtp = await bcrypt.hash(otp, 10);
          const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

          await db.query(
            `UPDATE users
                SET login_otp_hash = $1,
                    login_otp_expires = $2,
                    login_otp_attempts = 0
              WHERE id = $3`,
            [hashedOtp, otpExpires, user.id],
          );

          const pendingToken = jwt.sign(
            { id: user.id, purpose: "login-otp" },
            process.env.JWT_SECRET,
            { expiresIn: "10m" },
          );
          setPendingLoginCookie(res, pendingToken);

          try {
            await sendLoginOtpEmail(user, otp);
          } catch (mailErr) {
            await clearOtpChallenge(user.id).catch(() => {});
            clearPendingLoginCookie(res);
            logger.error("failed to send login otp", {
              userId: user.id,
              error: mailErr.message,
            });
            return res.status(500).json({
              message:
                "We could not send your verification code right now. Please try again.",
            });
          }

          return res.status(202).json({
            message:
              "We sent a verification code to your email address. Enter it to finish signing in.",
            requiresOtp: true,
            userId: user.id,
            username: user.username,
            emailMasked: maskEmail(user.email),
            expiresInMinutes: 10,
          });
        }

        const { token } = await issueUserAuthSession(
          res,
          user,
          req,
          "password",
        );

        res.status(200).json({
          message: "Logged in successfully.",
          userId: user.id,
          username: user.username,
          token,
        });
        logger.info("user login", { userId: user.id });
      } else {
        // Same generic message as the "user not found" case above.
        // Do NOT say "incorrect password" — that confirms the account exists.
        res.status(401).json({ message: "Invalid email or password." });
      }
    } catch (error) {
      console.log(error.message);
      return res
        .status(500)
        .json({ message: "An error occurred during login. Please try again." });
    }
  },
);

router.post(
  "/login/verify-otp",
  [
    body("otp")
      .trim()
      .notEmpty()
      .isLength({ min: 6, max: 6 })
      .withMessage("A 6-digit verification code is required.")
      .isNumeric()
      .withMessage("The verification code must contain only numbers."),
  ],
  validate,
  async (req, res) => {
    try {
      const pendingToken = req.cookies.loginOtp;
      if (!pendingToken) {
        return res.status(401).json({
          message: "Your verification session expired. Please sign in again.",
        });
      }

      const decoded = jwt.verify(pendingToken, process.env.JWT_SECRET);
      const userId = decoded?.id;
      if (!userId) {
        clearPendingLoginCookie(res);
        return res.status(401).json({
          message: "Your verification session expired. Please sign in again.",
        });
      }

      const result = await db.query(
        `SELECT id, username, email, name, password, two_factor_enabled,
                login_otp_hash, login_otp_expires, login_otp_attempts
           FROM users
          WHERE id = $1`,
        [userId],
      );

      if (result.rows.length === 0) {
        clearPendingLoginCookie(res);
        return res.status(401).json({
          message: "Your verification session expired. Please sign in again.",
        });
      }

      const user = result.rows[0];
      if (
        !user.login_otp_hash ||
        !user.login_otp_expires ||
        new Date(user.login_otp_expires).getTime() < Date.now()
      ) {
        await clearOtpChallenge(user.id).catch(() => {});
        clearPendingLoginCookie(res);
        return res.status(401).json({
          message: "Your verification code expired. Please sign in again.",
        });
      }

      const isMatch = await bcrypt.compare(req.body.otp, user.login_otp_hash);
      if (!isMatch) {
        const nextAttempts = Number(user.login_otp_attempts || 0) + 1;
        if (nextAttempts >= 5) {
          await clearOtpChallenge(user.id).catch(() => {});
          clearPendingLoginCookie(res);
          return res.status(401).json({
            message:
              "The verification code was incorrect too many times. Please sign in again.",
          });
        }

        await db.query(
          `UPDATE users
              SET login_otp_attempts = $1
            WHERE id = $2`,
          [nextAttempts, user.id],
        );

        return res.status(401).json({
          message: "The verification code is incorrect. Please try again.",
        });
      }

      await clearOtpChallenge(user.id);
      clearPendingLoginCookie(res);

      const { token } = await issueUserAuthSession(
        res,
        user,
        req,
        "password-otp",
      );
      logger.info("user login with otp", { userId: user.id });

      return res.status(200).json({
        message: "Logged in successfully.",
        userId: user.id,
        username: user.username,
        token,
      });
    } catch (error) {
      console.error(error.message);
      return res.status(500).json({
        message: "An error occurred during verification. Please try again.",
      });
    }
  },
);

router.post("/login/resend-otp", async (req, res) => {
  try {
    const pendingToken = req.cookies.loginOtp;
    if (!pendingToken) {
      return res.status(401).json({
        message: "Your verification session expired. Please sign in again.",
      });
    }

    const decoded = jwt.verify(pendingToken, process.env.JWT_SECRET);
    const userId = decoded?.id;
    if (!userId) {
      clearPendingLoginCookie(res);
      return res.status(401).json({
        message: "Your verification session expired. Please sign in again.",
      });
    }

    const result = await db.query(
      `SELECT id, username, email, name, two_factor_enabled
           FROM users
          WHERE id = $1`,
      [userId],
    );

    if (result.rows.length === 0 || !result.rows[0].two_factor_enabled) {
      clearPendingLoginCookie(res);
      return res.status(401).json({
        message: "Your verification session expired. Please sign in again.",
      });
    }

    const user = result.rows[0];
    const otp = generateOtp();
    const hashedOtp = await bcrypt.hash(otp, 10);
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

    await db.query(
      `UPDATE users
            SET login_otp_hash = $1,
                login_otp_expires = $2,
                login_otp_attempts = 0
          WHERE id = $3`,
      [hashedOtp, otpExpires, user.id],
    );

    await sendLoginOtpEmail(user, otp);

    return res.status(200).json({
      message: "A new verification code has been sent to your email address.",
    });
  } catch (error) {
    console.error(error.message);
    return res.status(500).json({
      message: "We could not resend the verification code. Please try again.",
    });
  }
});

export default router;
