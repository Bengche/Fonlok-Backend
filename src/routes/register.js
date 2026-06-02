import express from "express";
const router = express.Router();
import db from "../controllers/db.js";
import multer from "multer";
import bcrypt from "bcrypt";
import crypto from "crypto";
import sgMail from "@sendgrid/mail";
import { body } from "express-validator";
import { validate } from "../middleware/validate.js";
import { uploadToCloudinary } from "../utils/cloudinary.js";
import { emailWrap } from "../utils/emailTemplate.js";
const saltRounds = 10;

if (process.env.SENDGRID_API_KEY?.startsWith("SG.")) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// ── DB migration: email verification columns ────────────────────────────────
db.query(
  `
  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS email_verification_otp_hash TEXT,
    ADD COLUMN IF NOT EXISTS email_verification_otp_expires TIMESTAMPTZ
`,
).catch((e) => console.error("⚠️  email_verified migration error:", e.message));

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  if (!local || !domain) return email;
  return `${local.slice(0, 2)}***@${domain}`;
}

async function sendVerificationEmail(user, otp) {
  const frontendUrl = process.env.FRONTEND_URL || "https://fonlok.com";
  const verifyLink = `${frontendUrl}/verify-email?email=${encodeURIComponent(user.email)}&code=${otp}`;

  const bodyHtml = `
    <h2 style="color:#0F1F3D;margin:0 0 8px;font-size:22px;">Verify your email address</h2>
    <p style="color:#475569;line-height:1.7;margin:0 0 20px;">
      Hi <strong>${user.name}</strong>, welcome to Fonlok! To complete your registration,
      either enter the 6-digit code below or click the button to verify instantly.
      This code and link expire in <strong>15 minutes</strong>.
    </p>

    <div style="margin:24px 0;padding:22px 24px;border-radius:14px;background:linear-gradient(135deg,rgba(15,31,61,0.04),rgba(245,158,11,0.16));border:1px solid rgba(15,31,61,0.12);text-align:center;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#64748b;margin-bottom:12px;">Your verification code</div>
      <div style="font-size:36px;letter-spacing:0.28em;font-weight:800;color:#0F1F3D;font-family:monospace;">${otp}</div>
      <div style="margin-top:10px;font-size:12px;color:#64748b;">Expires in 15 minutes</div>
    </div>

    <p style="color:#475569;font-size:13px;text-align:center;margin:0 0 14px;">Or skip the code and verify with one click:</p>
    <div style="text-align:center;margin:0 0 24px;">
      <a href="${verifyLink}"
         style="display:inline-block;padding:13px 32px;background:#F59E0B;color:#0F1F3D;font-weight:700;font-size:15px;border-radius:9px;text-decoration:none;letter-spacing:-0.01em;">
        Verify my email address
      </a>
    </div>

    <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0;">
      If the button doesn't work, copy and paste this link into your browser:<br>
      <a href="${verifyLink}" style="color:#64748b;word-break:break-all;">${verifyLink}</a>
    </p>
    <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:12px 0 0;">
      If you did not create a Fonlok account, you can safely ignore this email.
    </p>
  `;
  await sgMail.send({
    to: user.email,
    from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
    subject: "Verify your Fonlok email address",
    html: emailWrap(bodyHtml, { subtitle: "Email Verification" }),
  });
}

async function sendWelcomeEmail(user) {
  const bodyHtml = `
    <h2 style="color:#0F1F3D;margin:0 0 8px;font-size:22px;">Welcome to Fonlok, ${user.name}!</h2>
    <p style="color:#475569;line-height:1.7;margin:0 0 20px;">
      Your email has been verified and your account is now fully active. Fonlok is a secure escrow
      platform that protects both buyers and sellers throughout every transaction.
    </p>
    <div style="background:#f8fafc;border-radius:12px;padding:20px 24px;margin:0 0 20px;border:1px solid #e2e8f0;">
      <p style="margin:0 0 14px;font-weight:700;color:#0F1F3D;font-size:15px;">Here's what you can do next:</p>
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:8px 0;vertical-align:top;width:28px;">
            <span style="display:inline-block;width:22px;height:22px;background:#F59E0B;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:800;color:#0F1F3D;">1</span>
          </td>
          <td style="padding:8px 0;color:#374151;line-height:1.6;font-size:14px;">
            <strong>Create an invoice</strong> — Send a payment request to any buyer for goods or services.
            Funds are held securely in escrow until both parties are satisfied.
          </td>
        </tr>
        <tr>
          <td style="padding:8px 0;vertical-align:top;width:28px;">
            <span style="display:inline-block;width:22px;height:22px;background:#F59E0B;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:800;color:#0F1F3D;">2</span>
          </td>
          <td style="padding:8px 0;color:#374151;line-height:1.6;font-size:14px;">
            <strong>Complete your profile</strong> — Add a profile photo, verify your identity (KYC),
            and set your preferred Mobile Money number for payouts.
          </td>
        </tr>
        <tr>
          <td style="padding:8px 0;vertical-align:top;width:28px;">
            <span style="display:inline-block;width:22px;height:22px;background:#F59E0B;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:800;color:#0F1F3D;">3</span>
          </td>
          <td style="padding:8px 0;color:#374151;line-height:1.6;font-size:14px;">
            <strong>Invite your network</strong> — Share your referral link and earn rewards for every
            new user who joins Fonlok through you.
          </td>
        </tr>
      </table>
    </div>
    <div style="text-align:center;margin:24px 0;">
      <a href="${process.env.FRONTEND_URL || "https://fonlok.com"}/dashboard"
         style="display:inline-block;padding:13px 32px;background:#F59E0B;color:#0F1F3D;font-weight:700;font-size:15px;border-radius:9px;text-decoration:none;letter-spacing:-0.01em;">
        Go to my Dashboard
      </a>
    </div>
    <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:0;text-align:center;">
      Need help? Contact our support team at
      <a href="mailto:${process.env.VERIFIED_SENDER}" style="color:#F59E0B;">${process.env.VERIFIED_SENDER}</a>
    </p>
  `;
  await sgMail.send({
    to: user.email,
    from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
    subject: "Welcome to Fonlok — Your account is ready",
    html: emailWrap(bodyHtml, { subtitle: "Welcome to Fonlok" }),
  });
}

// Generates a short, clean referral code (e.g. "X7K2MN")
// Excludes confusing characters like 0, O, I, 1
const generateReferralCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else
      cb(
        new multer.MulterError(
          "LIMIT_UNEXPECTED_FILE",
          "Only image files are allowed",
        ),
      );
  },
});

router.post(
  "/register",
  upload.single("image"),
  [
    body("name")
      .trim()
      .notEmpty()
      .withMessage("Full name is required.")
      .isLength({ max: 100 })
      .withMessage("Name must be 100 characters or fewer."),

    body("username")
      .trim()
      .notEmpty()
      .withMessage("Username is required.")
      .isLength({ max: 30 })
      .withMessage("Username must be 30 characters or fewer.")
      .matches(/^[a-zA-Z0-9_]+$/)
      .withMessage(
        "Username can only contain letters, numbers, and underscores.",
      ),

    body("email")
      .trim()
      .isEmail()
      .withMessage("A valid email address is required.")
      .normalizeEmail(),

    body("phone")
      .trim()
      .notEmpty()
      .withMessage("Phone number is required.")
      .matches(/^237[62]\d{8}$/)
      .withMessage(
        "Enter a valid Cameroonian phone number (e.g. 2376XXXXXXXX).",
      ),

    body("password")
      .notEmpty()
      .withMessage("Password is required.")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters."),

    body("dob")
      .trim()
      .notEmpty()
      .withMessage("Date of birth is required.")
      .isISO8601()
      .withMessage("Enter a valid date of birth (YYYY-MM-DD).")
      .custom((dob) => {
        const birth = new Date(dob);
        const today = new Date();
        let age = today.getFullYear() - birth.getFullYear();
        const m = today.getMonth() - birth.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
        if (age < 18) {
          throw new Error(
            "You must be at least 18 years old to create a Fonlok account.",
          );
        }
        return true;
      }),

    body("country")
      .trim()
      .notEmpty()
      .withMessage("Country is required.")
      .escape(),

    body("referral_code")
      .optional({ checkFalsy: true })
      .trim()
      .toUpperCase()
      .isAlphanumeric()
      .withMessage("Referral code can only contain letters and numbers.")
      .isLength({ max: 12 })
      .withMessage("Referral code is too long."),
  ],
  validate,
  async (req, res) => {
    const {
      name,
      username,
      email,
      phone,
      password,
      dob,
      country,
      referral_code,
    } = req.body;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Upload profile picture to Cloudinary (if provided)
    let profilePicture = null;
    if (req.file) {
      try {
        const { url } = await uploadToCloudinary(req.file.buffer, {
          folder: "fonlok/avatars",
          resource_type: "image",
        });
        profilePicture = url;
      } catch (uploadErr) {
        console.warn(
          "⚠️  Profile picture upload failed during registration:",
          uploadErr.message,
        );
        // Non-fatal — account is still created without a picture
      }
    }
    const normalizedEmail = email.toLowerCase();

    try {
      // 1. If a referral_code was provided, find the referrer BEFORE creating the user
      //    We do this first so we can reject invalid codes early and cleanly
      let referrerId = null;
      if (referral_code && referral_code.trim() !== "") {
        const referrerCheck = await db.query(
          "SELECT id FROM users WHERE referral_code = $1",
          [referral_code.trim().toUpperCase()],
        );
        if (referrerCheck.rows.length === 0) {
          return res.status(400).json({
            message: "Invalid referral code. Please check and try again.",
          });
        }
        referrerId = referrerCheck.rows[0].id;
      }

      // 1b. Block registration if email or phone was previously used on a deleted account
      const deletedCheck = await db.query(
        `SELECT id FROM users WHERE deleted_at IS NOT NULL AND (email = $1 OR phone = $2) LIMIT 1`,
        [normalizedEmail, phone],
      );
      if (deletedCheck.rows.length > 0) {
        return res.status(409).json({
          message:
            "This email address or phone number cannot be used to create a new account. Please contact support if you believe this is an error.",
        });
      }

      // 2. Create the user account
      const newUser = await db.query(
        "INSERT INTO users (name, email, phone, password, username, dob, country, profilePicture, referred_by) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *",
        [
          name,
          normalizedEmail,
          phone,
          passwordHash,
          username,
          dob,
          country,
          profilePicture,
          referrerId, // NULL if no referral code was provided
        ],
      );

      const newUserId = newUser.rows[0].id;

      // 3. Generate a unique referral code for this new user
      //    We keep trying until we find one that doesn't already exist
      let newReferralCode = "";
      let codeSaved = false;
      while (!codeSaved) {
        try {
          newReferralCode = generateReferralCode();
          await db.query("UPDATE users SET referral_code = $1 WHERE id = $2", [
            newReferralCode,
            newUserId,
          ]);
          codeSaved = true;
        } catch (err) {
          // If the code already exists (unique constraint violation), try again
          if (err.code === "23505") {
            continue;
          } else {
            throw err;
          }
        }
      }
      console.log(
        `✅ Referral code generated for user ${newUserId}: ${newReferralCode}`,
      );

      // 4. Check if this email already exists in the guests table
      //    (meaning this person made purchases before creating an account)
      const guestCheck = await db.query(
        "SELECT * FROM guests WHERE email = $1",
        [normalizedEmail],
      );

      if (guestCheck.rows.length > 0) {
        // 5. If they were a guest before, link all their guest records to their new account
        //    This carries over their purchase history
        await db.query(
          "UPDATE guests SET registered_userid = $1 WHERE email = $2",
          [newUserId, normalizedEmail],
        );
        console.log(`✅ Guest history carried over for ${normalizedEmail}`);
      }

      // 5. Generate and send email verification OTP
      const otp = generateOtp();
      const otpHash = await bcrypt.hash(otp, 10);
      const otpExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

      await db.query(
        `UPDATE users
           SET email_verification_otp_hash = $1,
               email_verification_otp_expires = $2
         WHERE id = $3`,
        [otpHash, otpExpires, newUserId],
      );

      try {
        await sendVerificationEmail(newUser.rows[0], otp);
      } catch (emailErr) {
        console.warn("⚠️  Verification email failed:", emailErr.message);
      }

      res.status(201).json({
        ok: true,
        requiresVerification: true,
        email: maskEmail(normalizedEmail),
      });
      console.log(`✅ User Registered — awaiting email verification`);
    } catch (error) {
      // Handle PostgreSQL unique constraint violations with specific messages
      if (error.code === "23505") {
        const detail = (error.detail || "").toLowerCase();
        const constraint = (error.constraint || "").toLowerCase();
        if (detail.includes("email") || constraint.includes("email")) {
          return res.status(409).json({
            message:
              "An account with this email address already exists. Please log in or use a different email.",
          });
        }
        if (detail.includes("username") || constraint.includes("username")) {
          return res.status(409).json({
            message:
              "This username is already taken. Please choose a different username.",
          });
        }
        if (detail.includes("phone") || constraint.includes("phone")) {
          return res.status(409).json({
            message:
              "An account with this phone number already exists. Please log in or use a different phone number.",
          });
        }
        return res.status(409).json({
          message:
            "An account with these details already exists. Please check your information and try again.",
        });
      }
      console.log(error.message);
      res
        .status(500)
        .json({ message: "Failed to register user. Please try again." });
    }
  },
);

// ── POST /auth/verify-email ─────────────────────────────────────────────────
// Verifies the OTP sent during registration and marks the email as verified.
router.post(
  "/verify-email",
  [
    body("email")
      .trim()
      .isEmail()
      .withMessage("A valid email address is required.")
      .normalizeEmail(),
    body("otp")
      .trim()
      .notEmpty()
      .withMessage("Verification code is required.")
      .isLength({ min: 6, max: 6 })
      .withMessage("Verification code must be 6 digits.")
      .isNumeric()
      .withMessage("Verification code must be numeric."),
  ],
  validate,
  async (req, res) => {
    const { email, otp } = req.body;
    const normalizedEmail = email.toLowerCase();

    try {
      const result = await db.query(
        `SELECT id, name, email, email_verified, email_verification_otp_hash, email_verification_otp_expires
           FROM users
          WHERE email = $1 AND deleted_at IS NULL`,
        [normalizedEmail],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ message: "Account not found." });
      }

      const user = result.rows[0];

      if (user.email_verified) {
        return res
          .status(409)
          .json({ message: "This email address has already been verified." });
      }

      if (
        !user.email_verification_otp_hash ||
        !user.email_verification_otp_expires
      ) {
        return res.status(400).json({
          message:
            "No verification code found for this account. Please request a new one.",
        });
      }

      if (new Date() > new Date(user.email_verification_otp_expires)) {
        return res.status(400).json({
          code: "OTP_EXPIRED",
          message:
            "Your verification code has expired. Please request a new one.",
        });
      }

      const isMatch = await bcrypt.compare(
        otp,
        user.email_verification_otp_hash,
      );
      if (!isMatch) {
        return res
          .status(400)
          .json({
            code: "OTP_INVALID",
            message: "Incorrect verification code. Please try again.",
          });
      }

      // Mark verified and clear OTP
      await db.query(
        `UPDATE users
            SET email_verified = true,
                email_verification_otp_hash = NULL,
                email_verification_otp_expires = NULL
          WHERE id = $1`,
        [user.id],
      );

      // Send welcome email (non-fatal)
      try {
        await sendWelcomeEmail(user);
      } catch (emailErr) {
        console.warn("⚠️  Welcome email failed:", emailErr.message);
      }

      console.log(`✅ Email verified for user ${user.id}`);
      res.json({ ok: true });
    } catch (err) {
      console.error("verify-email error:", err.message);
      res.status(500).json({
        message: "Email verification failed. Please try again.",
      });
    }
  },
);

// ── POST /auth/resend-verification ─────────────────────────────────────────
// Resends a fresh OTP to an unverified email address (rate-limited by caller).
router.post(
  "/resend-verification",
  [
    body("email")
      .trim()
      .isEmail()
      .withMessage("A valid email address is required.")
      .normalizeEmail(),
  ],
  validate,
  async (req, res) => {
    const normalizedEmail = req.body.email.toLowerCase();

    try {
      const result = await db.query(
        `SELECT id, name, email, email_verified
           FROM users
          WHERE email = $1 AND deleted_at IS NULL`,
        [normalizedEmail],
      );

      // Return the same response whether found or not (prevents enumeration)
      if (result.rows.length === 0 || result.rows[0].email_verified) {
        return res.json({ ok: true });
      }

      const user = result.rows[0];
      const otp = generateOtp();
      const otpHash = await bcrypt.hash(otp, 10);
      const otpExpires = new Date(Date.now() + 15 * 60 * 1000);

      await db.query(
        `UPDATE users
            SET email_verification_otp_hash = $1,
                email_verification_otp_expires = $2
          WHERE id = $3`,
        [otpHash, otpExpires, user.id],
      );

      try {
        await sendVerificationEmail(user, otp);
      } catch (emailErr) {
        console.warn("⚠️  Resend verification email failed:", emailErr.message);
      }

      res.json({ ok: true });
    } catch (err) {
      console.error("resend-verification error:", err.message);
      res
        .status(500)
        .json({ message: "Failed to resend verification. Please try again." });
    }
  },
);

export default router;
