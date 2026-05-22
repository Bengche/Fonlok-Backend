/**
 * kyc.js — KYC (Know Your Customer) identity verification routes
 *
 * Routes:
 *   POST   /kyc/submit          — submit a new KYC application (multipart/form-data)
 *   GET    /kyc/status          — get the current user's KYC status
 *
 * Document types accepted:
 *   national_id        → front + back images required
 *   drivers_license    → front + back images required
 *   passport           → biographical data page only (1 image)
 *
 * All images are stored in Cloudinary under fonlok/kyc/{userId}/{type}
 */

import express from "express";
import multer from "multer";
import sgMail from "@sendgrid/mail";
import db from "../controllers/db.js";
import authMiddleware from "../middleware/authMiddleware.js";
import {
  uploadToCloudinary,
  deleteFromCloudinary,
} from "../utils/cloudinary.js";
import {
  emailWrap,
  emailTable,
  emailButton,
  emailButtonNavy,
} from "../utils/emailTemplate.js";
import { BRAND } from "../config/brand.js";
import logger from "../utils/logger.js";
import dotenv from "dotenv";
dotenv.config();

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const router = express.Router();

// ── Auto-migrate: ensure table and column exist on first import ──────────────
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS kyc_verifications (
        id                       SERIAL PRIMARY KEY,
        user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status                   VARCHAR(20) NOT NULL DEFAULT 'pending',

        full_name                VARCHAR(255) NOT NULL,
        date_of_birth            DATE NOT NULL,
        nationality              VARCHAR(100) NOT NULL,
        phone                    VARCHAR(60) NOT NULL,
        address                  TEXT NOT NULL,
        city                     VARCHAR(100) NOT NULL,
        country                  VARCHAR(100) NOT NULL DEFAULT 'Cameroon',

        document_type            VARCHAR(30) NOT NULL,
        document_number          VARCHAR(100) NOT NULL,

        document_front_url       TEXT,
        document_front_public_id TEXT,
        document_back_url        TEXT,
        document_back_public_id  TEXT,
        selfie_url               TEXT,
        selfie_public_id         TEXT,

        admin_note               TEXT,
        reviewed_at              TIMESTAMPTZ,
        reviewed_by              VARCHAR(100),

        submitted_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Add kyc_status column to users table if it doesn't exist yet
    await db.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(20) NOT NULL DEFAULT 'unverified'
    `);

    logger.info("KYC: table and column migration complete");
  } catch (err) {
    logger.warn("KYC migration warning (non-fatal):", { message: err.message });
  }
})();

// ── Multer — memory storage, 3 files (front, back, selfie), 8 MB each ────────
const kycUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB per file
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPEG, PNG, WebP, or HEIC images are accepted."));
  },
}).fields([
  { name: "document_front", maxCount: 1 },
  { name: "document_back", maxCount: 1 },
  { name: "selfie", maxCount: 1 },
]);

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Sanitise a string: trim, single internal spaces */
const clean = (v) =>
  String(v ?? "")
    .trim()
    .replace(/\s+/g, " ");

/** Simple date validation: must be a past date, user must be ≥16 */
const validateDob = (raw) => {
  const d = new Date(raw);
  if (isNaN(d.getTime())) return false;
  const today = new Date();
  const age = today.getFullYear() - d.getFullYear();
  return age >= 16 && d < today;
};

// ── POST /kyc/submit ──────────────────────────────────────────────────────────
router.post("/submit", authMiddleware, (req, res) => {
  kycUpload(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ message: `Upload error: ${err.message}` });
    }
    if (err) {
      return res.status(400).json({ message: err.message });
    }

    const userId = req.user.id;

    // ── 1. Block if already approved ──────────────────────────────────────────
    const existingRow = await db.query(
      "SELECT id, status FROM kyc_verifications WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 1",
      [userId],
    );
    if (existingRow.rows.length && existingRow.rows[0].status === "approved") {
      return res
        .status(409)
        .json({ message: "Your identity is already verified." });
    }

    // ── 2. Validate body ──────────────────────────────────────────────────────
    const fullName = clean(req.body.full_name);
    const dob = clean(req.body.date_of_birth);
    const nationality = clean(req.body.nationality);
    const phone = clean(req.body.phone);
    const address = clean(req.body.address);
    const city = clean(req.body.city);
    const country = clean(req.body.country) || "Cameroon";
    const docType = clean(req.body.document_type);
    const docNumber = clean(req.body.document_number);

    const validDocTypes = ["national_id", "drivers_license", "passport"];
    if (!validDocTypes.includes(docType)) {
      return res.status(400).json({
        message:
          "Invalid document type. Choose national_id, drivers_license, or passport.",
      });
    }
    if (!fullName || fullName.length < 3) {
      return res
        .status(400)
        .json({ message: "Full name is required (minimum 3 characters)." });
    }
    if (!validateDob(dob)) {
      return res.status(400).json({
        message:
          "A valid date of birth is required. You must be at least 16 years old.",
      });
    }
    if (!nationality)
      return res.status(400).json({ message: "Nationality is required." });
    if (!phone)
      return res.status(400).json({ message: "Phone number is required." });
    if (!address)
      return res
        .status(400)
        .json({ message: "Residential address is required." });
    if (!city) return res.status(400).json({ message: "City is required." });
    if (!docNumber)
      return res.status(400).json({ message: "Document number is required." });

    // ── 3. Validate uploaded files ────────────────────────────────────────────
    const files = req.files || {};
    if (!files.document_front?.[0]) {
      return res.status(400).json({
        message:
          docType === "passport"
            ? "Please upload a photo of your passport data page."
            : "Please upload the front of your identity document.",
      });
    }
    if (docType !== "passport" && !files.document_back?.[0]) {
      return res
        .status(400)
        .json({ message: "Please upload the back of your identity document." });
    }
    if (!files.selfie?.[0]) {
      return res
        .status(400)
        .json({ message: "Please upload a selfie photograph." });
    }

    // ── 4. Upload to Cloudinary ────────────────────────────────────────────────
    const folder = `fonlok/kyc/${userId}`;
    let frontUrl, frontPid, backUrl, backPid, selfieUrl, selfiePid;
    try {
      const frontResult = await uploadToCloudinary(
        files.document_front[0].buffer,
        {
          folder,
          resource_type: "image",
          public_id: `doc_front_${Date.now()}`,
          transformation: [{ quality: "auto" }],
        },
      );
      frontUrl = frontResult.url;
      frontPid = frontResult.publicId;

      if (docType !== "passport" && files.document_back?.[0]) {
        const backResult = await uploadToCloudinary(
          files.document_back[0].buffer,
          {
            folder,
            resource_type: "image",
            public_id: `doc_back_${Date.now()}`,
            transformation: [{ quality: "auto" }],
          },
        );
        backUrl = backResult.url;
        backPid = backResult.publicId;
      }

      const selfieResult = await uploadToCloudinary(files.selfie[0].buffer, {
        folder,
        resource_type: "image",
        public_id: `selfie_${Date.now()}`,
        transformation: [{ quality: "auto" }],
      });
      selfieUrl = selfieResult.url;
      selfiePid = selfieResult.publicId;
    } catch (uploadErr) {
      logger.error("KYC Cloudinary upload failed", {
        error: uploadErr.message,
      });
      return res
        .status(500)
        .json({ message: "Failed to upload documents. Please try again." });
    }

    // ── 5. If there was a prior rejected submission, delete old images & update row ─
    try {
      if (
        existingRow.rows.length &&
        existingRow.rows[0].status === "rejected"
      ) {
        const old = await db.query(
          "SELECT * FROM kyc_verifications WHERE id = $1",
          [existingRow.rows[0].id],
        );
        const o = old.rows[0];
        await Promise.allSettled([
          deleteFromCloudinary(o.document_front_public_id),
          deleteFromCloudinary(o.document_back_public_id),
          deleteFromCloudinary(o.selfie_public_id),
        ]);
        await db.query(
          `UPDATE kyc_verifications
           SET full_name=$1, date_of_birth=$2, nationality=$3, phone=$4,
               address=$5, city=$6, country=$7, document_type=$8, document_number=$9,
               document_front_url=$10, document_front_public_id=$11,
               document_back_url=$12, document_back_public_id=$13,
               selfie_url=$14, selfie_public_id=$15,
               status='pending', admin_note=NULL, reviewed_at=NULL, reviewed_by=NULL,
               submitted_at=NOW(), updated_at=NOW()
           WHERE id=$16`,
          [
            fullName,
            dob,
            nationality,
            phone,
            address,
            city,
            country,
            docType,
            docNumber,
            frontUrl,
            frontPid,
            backUrl || null,
            backPid || null,
            selfieUrl,
            selfiePid,
            existingRow.rows[0].id,
          ],
        );
      } else {
        // Fresh submission
        await db.query(
          `INSERT INTO kyc_verifications
             (user_id, full_name, date_of_birth, nationality, phone, address, city, country,
              document_type, document_number,
              document_front_url, document_front_public_id,
              document_back_url, document_back_public_id,
              selfie_url, selfie_public_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            userId,
            fullName,
            dob,
            nationality,
            phone,
            address,
            city,
            country,
            docType,
            docNumber,
            frontUrl,
            frontPid,
            backUrl || null,
            backPid || null,
            selfieUrl,
            selfiePid,
          ],
        );
      }

      // Update user's kyc_status to pending
      await db.query("UPDATE users SET kyc_status='pending' WHERE id=$1", [
        userId,
      ]);
    } catch (dbErr) {
      logger.error("KYC DB insert failed", { error: dbErr.message });
      return res
        .status(500)
        .json({ message: "Submission failed. Please try again." });
    }

    // ── 6. Fetch the user's email for notifications ────────────────────────────
    let userEmail, userName;
    try {
      const uRes = await db.query(
        "SELECT email, name, username FROM users WHERE id=$1",
        [userId],
      );
      userEmail = uRes.rows[0]?.email;
      userName = uRes.rows[0]?.name || uRes.rows[0]?.username || "User";
    } catch {
      /* non-fatal */
    }

    // ── 7. Email to user ───────────────────────────────────────────────────────
    if (userEmail && process.env.SENDGRID_API_KEY?.startsWith("SG.")) {
      const docTypeLabel =
        {
          national_id: "National ID Card",
          drivers_license: "Driver's Licence",
          passport: "International Passport",
        }[docType] || docType;
      const body = `
        <h2 style="margin:0 0 6px;color:#0f172a;font-size:20px;font-weight:800;">Identity Verification Received</h2>
        <p style="color:#475569;margin:0 0 18px;line-height:1.6;">
          Hi ${userName}, thank you for submitting your identity verification request.
          Our compliance team will review your documents within <strong>1–3 business days</strong>.
          You will be notified by email and push notification once a decision has been made.
        </p>
        ${emailTable([
          ["Full Name", fullName],
          ["Document Type", docTypeLabel],
          ["Document Number", docNumber],
          [
            "Date Submitted",
            new Date().toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            }),
          ],
          [
            "Current Status",
            '<span style="background:#fef3c7;color:#92400e;padding:3px 10px;border-radius:999px;font-weight:700;font-size:12px;">Under Review</span>',
            "",
          ],
        ])}
        <p style="color:#64748b;font-size:13px;margin:16px 0 0;line-height:1.6;">
          Please ensure your account email and phone number are up to date while your application is being reviewed.
          If you need to contact us, reply to this email or message us on WhatsApp at
          <a href="${BRAND.whatsappUrl}" style="color:#0F1F3D;">${BRAND.contact.phone}</a>.
        </p>
        ${emailButton(`${BRAND.siteUrl}/kyc`, "View Verification Status")}
      `;
      try {
        await sgMail.send({
          to: userEmail,
          from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
          subject: `${BRAND.name} — Identity Verification Received`,

          html: emailWrap(body, { subtitle: "Identity Verification" }),
        });
      } catch (emailErr) {
        logger.warn("KYC user email failed", { error: emailErr.message });
      }
    }

    // ── 8. Email to admin ──────────────────────────────────────────────────────
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail && process.env.SENDGRID_API_KEY?.startsWith("SG.")) {
      const docTypeLabel =
        {
          national_id: "National ID Card",
          drivers_license: "Driver's Licence",
          passport: "International Passport",
        }[docType] || docType;
      const adminBody = `
        <h2 style="margin:0 0 6px;color:#0f172a;font-size:20px;font-weight:800;">New KYC Verification Request</h2>
        <p style="color:#475569;margin:0 0 18px;line-height:1.6;">A user has submitted a new identity verification request and is awaiting your review.</p>
        ${emailTable([
          ["User ID", String(userId)],
          ["Full Name", fullName],
          ["Document Type", docTypeLabel],
          ["Document Number", docNumber],
          ["Nationality", nationality],
          ["Phone", phone],
          ["City / Country", `${city}, ${country}`],
          ["Date of Birth", dob],
          ["Submitted At", new Date().toLocaleString("en-GB")],
        ])}
        ${emailButtonNavy(`${process.env.FRONTEND_URL || BRAND.siteUrl}/admin/dashboard`, "Review in Admin Dashboard")}
      `;
      try {
        await sgMail.send({
          to: adminEmail,
          from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
          subject: `[${BRAND.name}] New KYC Request — ${fullName}`,

          html: emailWrap(adminBody, { subtitle: "Admin — Compliance Review" }),
        });
      } catch (emailErr) {
        logger.warn("KYC admin email failed", { error: emailErr.message });
      }
    }

    return res.status(200).json({
      message:
        "Verification submitted successfully. We will review your documents within 1–3 business days.",
      status: "pending",
    });
  });
});

// ── GET /kyc/status ───────────────────────────────────────────────────────────
router.get("/status", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const [userRes, kycRes] = await Promise.all([
      db.query("SELECT kyc_status FROM users WHERE id=$1", [userId]),
      db.query(
        `SELECT id, status, document_type, full_name, submitted_at, updated_at, admin_note, reviewed_at
         FROM kyc_verifications
         WHERE user_id=$1
         ORDER BY submitted_at DESC
         LIMIT 1`,
        [userId],
      ),
    ]);

    return res.json({
      kyc_status: userRes.rows[0]?.kyc_status || "unverified",
      application: kycRes.rows[0] || null,
    });
  } catch (err) {
    logger.error("KYC status fetch failed", { error: err.message });
    return res
      .status(500)
      .json({ message: "Failed to load verification status." });
  }
});

export default router;
