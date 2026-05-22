import express from "express";
const router = express.Router();
import jwt from "jsonwebtoken";
import db from "../controllers/db.js";
import authMiddleware from "../middleware/authMiddleware.js";
import dotenv from "dotenv";
import { body } from "express-validator";
import { validate } from "../middleware/validate.js";
import rateLimit from "express-rate-limit";
import sgMail from "@sendgrid/mail";
import { emailWrap, emailTable, emailButton } from "../utils/emailTemplate.js";
dotenv.config();

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// GET /profile/user-info/:userid
// Returns the username for a given user_id so the dashboard can build the profile link
router.get("/user-info/:userid", async (req, res) => {
  const { userid } = req.params;
  try {
    const result = await db.query("SELECT username FROM users WHERE id = $1", [
      userid,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }
    return res.status(200).json({ username: result.rows[0].username });
  } catch (error) {
    console.log(error.message);
    return res.status(500).json({ message: "Something went wrong." });
  }
});

// GET /profile/:username
// Public route — anyone can view a seller's profile
// Returns: seller info, completed invoices, reviews, and average rating
router.get("/:username", async (req, res) => {
  const { username } = req.params;

  try {
    // 1. Find the seller by username
    const userResult = await db.query(
      `SELECT id, name, username, country, profilepicture, createdat, phone,
              kyc_status, preferred_email_language, email, bio,
              COALESCE(tags, '{}') AS tags
       FROM users WHERE username = $1`,
      [username],
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: "Seller not found." });
    }
    const seller = userResult.rows[0];

    // 2. Get all delivered/completed invoices for this seller
    const invoicesResult = await db.query(
      `SELECT invoicename, amount, currency, status, createdat, delivered_at
       FROM invoices
       WHERE userid = $1 AND status IN ('delivered', 'completed')
       ORDER BY delivered_at DESC`,
      [seller.id],
    );

    // 3. Get all reviews — pinned first, then newest
    const reviewsResult = await db.query(
      `SELECT r.id, r.rating, r.comment, r.created_at,
              r.pinned, r.seller_reply, r.reply_created_at,
              r.show_invoice_name, r.invoice_name, r.invoice_amount, r.invoice_currency,
              COALESCE(NULLIF(TRIM(u.name), ''), u.username, r.reviewer_name, 'Anonymous') AS reviewer_name,
              r.reviewer_userid
       FROM reviews r
       LEFT JOIN users u ON u.id = r.reviewer_userid
       WHERE r.seller_userid = $1
       ORDER BY r.pinned DESC, r.created_at DESC`,
      [seller.id],
    );

    // 4. Calculate average rating
    const avgResult = await db.query(
      "SELECT ROUND(AVG(rating), 1) AS average FROM reviews WHERE seller_userid = $1",
      [seller.id],
    );
    const averageRating = avgResult.rows[0].average || 0;

    // 5. Count total completed transactions
    const completedCount = invoicesResult.rows.length;

    // 6. Total amount secured
    const securedResult = await db.query(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM invoices WHERE userid = $1 AND status IN ('delivered', 'completed')",
      [seller.id],
    );
    const totalSecured = parseFloat(securedResult.rows[0].total) || 0;

    // 7. Dispute count
    const disputeResult = await db.query(
      "SELECT COUNT(*) AS count FROM disputes WHERE invoicenumber IN (SELECT invoicenumber FROM invoices WHERE userid = $1)",
      [seller.id],
    );
    const disputeCount = parseInt(disputeResult.rows[0].count, 10) || 0;

    // 8. Verified sub-badges — derive from existing DB fields
    const verifiedBadges = {
      id: seller.kyc_status === "approved",
      phone: Boolean(seller.phone),
      email: Boolean(seller.email),
    };

    return res.status(200).json({
      seller,
      completedInvoices: invoicesResult.rows,
      reviews: reviewsResult.rows,
      averageRating,
      completedCount,
      totalSecured,
      disputeCount,
      verifiedBadges,
    });
  } catch (error) {
    console.log(error.message);
    return res
      .status(500)
      .json({ message: "Failed to load seller profile. Please try again." });
  }
});

// PATCH /profile/update-phone
// Authenticated users can update their own MoMo phone number
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
    } catch (error) {
      console.log(error.message);
      return res
        .status(500)
        .json({ message: "Failed to update phone number. Please try again." });
    }
  },
);

// POST /profile/review
// Buyers can leave a review after a completed transaction.
// Works for both authenticated users and guests (no account required).
router.post(
  "/review",
  // Optional auth: attach req.user if a valid token is present, but do not
  // block the request if there is no token.
  (req, res, next) => {
    const cookieToken = req.cookies.authToken || req.cookies.token;
    let headerToken = null;
    const authHeader = req.headers["authorization"] || req.headers["Authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const candidate = authHeader.slice(7);
      if (candidate && candidate !== "undefined" && candidate !== "null") {
        headerToken = candidate;
      }
    }
    const token = cookieToken || headerToken;
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
      } catch (_) {
        // Expired / invalid token — treat as guest
      }
    }
    next();
  },
  [
    body("seller_username")
      .trim()
      .notEmpty()
      .withMessage("Seller username is required.")
      .matches(/^[a-zA-Z0-9_]+$/)
      .withMessage("Invalid seller username.")
      .isLength({ max: 30 })
      .withMessage("Seller username is too long."),

    body("invoice_number")
      .trim()
      .notEmpty()
      .withMessage("Invoice number is required."),

    body("rating")
      .notEmpty()
      .withMessage("Rating is required.")
      .isInt({ min: 1, max: 5 })
      .withMessage("Rating must be between 1 and 5."),

    body("comment")
      .optional({ checkFalsy: true })
      .trim()
      .isLength({ max: 1000 })
      .withMessage("Review comment must be 1000 characters or fewer.")
      .escape(),

    // Required only for guest reviewers
    body("reviewer_name")
      .if((_, { req }) => !req.user)
      .trim()
      .notEmpty()
      .withMessage("Your name is required.")
      .isLength({ max: 100 })
      .withMessage("Name must be 100 characters or fewer.")
      .escape(),

    body("reviewer_email")
      .if((_, { req }) => !req.user)
      .trim()
      .notEmpty()
      .withMessage("Your email is required.")
      .isEmail()
      .withMessage("A valid email address is required.")
      .normalizeEmail(),
  ],
  validate,
  async (req, res) => {
    const isAuthenticated = !!req.user;
    const reviewerId = isAuthenticated ? req.user.id : null;
    const {
      seller_username,
      invoice_number,
      rating,
      comment,
      reviewer_email: guestEmail,
      reviewer_name: guestName,
    } = req.body;

    try {
      // 1. Find the seller
      const sellerResult = await db.query(
        "SELECT id FROM users WHERE username = $1",
        [seller_username],
      );
      if (sellerResult.rows.length === 0) {
        return res.status(404).json({ message: "Seller not found." });
      }
      const sellerId = sellerResult.rows[0].id;

      // 2. Invoice must be delivered or completed
      const invoiceCheck = await db.query(
        "SELECT * FROM invoices WHERE invoicenumber = $1 AND status IN ('delivered', 'completed')",
        [invoice_number],
      );
      if (invoiceCheck.rows.length === 0) {
        return res.status(403).json({
          message: "You can only leave a review for a completed and delivered invoice.",
        });
      }

      // 3. Verify the reviewer actually paid this invoice.
      //    Authenticated: match by user_id OR by their account email.
      //    Guest: match by the email they entered.
      let buyerCheck;
      if (isAuthenticated) {
        buyerCheck = await db.query(
          `SELECT * FROM guests
           WHERE invoicenumber = $1
             AND (
               user_id = $2
               OR email = (SELECT email FROM users WHERE id = $2)
             )`,
          [invoice_number, reviewerId],
        );
      } else {
        buyerCheck = await db.query(
          "SELECT * FROM guests WHERE invoicenumber = $1 AND email = $2",
          [invoice_number, guestEmail],
        );
      }
      if (buyerCheck.rows.length === 0) {
        return res.status(403).json({
          message: "You can only review sellers for invoices you have paid.",
        });
      }

      // 4. One review per buyer-seller pair.
      //    Same sentiment → 409. Opposite sentiment → UPDATE.
      const invoiceRow = invoiceCheck.rows[0];
      const showInvoiceName = req.body.show_invoice_name === true;
      const invoiceName = showInvoiceName ? invoiceRow.invoicename || null : null;
      const invoiceAmount = showInvoiceName ? invoiceRow.amount || null : null;
      const invoiceCurrency = showInvoiceName ? invoiceRow.currency || null : null;

      let existingReview;
      if (isAuthenticated) {
        existingReview = await db.query(
          "SELECT id, rating FROM reviews WHERE reviewer_userid = $1 AND seller_userid = $2",
          [reviewerId, sellerId],
        );
      } else {
        existingReview = await db.query(
          "SELECT id, rating FROM reviews WHERE reviewer_email = $1 AND seller_userid = $2",
          [guestEmail, sellerId],
        );
      }

      if (existingReview.rows.length > 0) {
        const existing = existingReview.rows[0];
        const existingIsPositive = existing.rating >= 4;
        const newIsPositive = Number(rating) >= 4;

        if (existingIsPositive === newIsPositive) {
          return res.status(409).json({
            message: "You have already left a review of this type for this seller.",
          });
        }

        // Opposite sentiment — update the existing review
        await db.query(
          `UPDATE reviews
             SET rating            = $1,
                 comment           = $2,
                 show_invoice_name = $3,
                 invoice_name      = $4,
                 invoice_amount    = $5,
                 invoice_currency  = $6,
                 invoice_number    = $7,
                 updated_at        = NOW()
           WHERE id = $8`,
          [rating, comment || null, showInvoiceName, invoiceName, invoiceAmount, invoiceCurrency, invoice_number, existing.id],
        );
        return res.status(200).json({ message: "Your review has been updated.", updated: true });
      }

      // 5. No prior review — insert
      await db.query(
        `INSERT INTO reviews
          (reviewer_userid, reviewer_email, reviewer_name, seller_userid,
           invoice_number, rating, comment,
           show_invoice_name, invoice_name, invoice_amount, invoice_currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          reviewerId,
          isAuthenticated ? null : guestEmail,
          isAuthenticated ? null : guestName,
          sellerId,
          invoice_number,
          rating,
          comment || null,
          showInvoiceName,
          invoiceName,
          invoiceAmount,
          invoiceCurrency,
        ],
      );

      return res.status(201).json({ message: "Your review has been submitted. Thank you!" });
    } catch (error) {
      console.log(error.message);
      return res.status(500).json({ message: "Failed to submit review. Please try again." });
    }
  },
);

// Public deal-request endpoint limiter: reduce spam and abusive automation.
const dealRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    type: "rate_limit",
    message:
      "Too many deal requests from this device. Please wait before trying again.",
  },
});

// POST /profile/deal-request
// Public endpoint to contact a seller from their profile.
router.post(
  "/deal-request",
  dealRequestLimiter,
  [
    body("seller_username")
      .trim()
      .notEmpty()
      .withMessage("Seller username is required.")
      .matches(/^[a-zA-Z0-9_]+$/)
      .withMessage("Invalid seller username.")
      .isLength({ max: 30 }),

    body("sender_name")
      .trim()
      .notEmpty()
      .withMessage("Your name is required.")
      .isLength({ max: 100 })
      .withMessage("Name is too long.")
      .escape(),

    body("sender_email")
      .trim()
      .isEmail()
      .withMessage("A valid email address is required.")
      .normalizeEmail(),

    body("message")
      .trim()
      .notEmpty()
      .withMessage("A message is required.")
      .isLength({ min: 10, max: 1000 })
      .withMessage("Message must be between 10 and 1000 characters.")
      .escape(),
  ],
  validate,
  async (req, res) => {
    const { seller_username, sender_name, sender_email, message } = req.body;

    try {
      const sellerResult = await db.query(
        "SELECT id, name, email FROM users WHERE username = $1",
        [seller_username],
      );
      if (sellerResult.rows.length === 0) {
        return res.status(404).json({ message: "Seller not found." });
      }
      const seller = sellerResult.rows[0];

      const FRONTEND_URL = process.env.FRONTEND_URL || "https://fonlok.com";
      const profileUrl = `${FRONTEND_URL.replace(/\/$/, "")}/seller/${seller_username}`;

      await sgMail.send({
        to: seller.email,
        from: process.env.VERIFIED_SENDER,
        subject: `New deal request from ${sender_name} - Fonlok`,
        html: emailWrap(
          `<h2 style="font-size:20px;font-weight:800;color:#0f172a;margin:0 0 8px;">You have a new deal request</h2>
           <p style="color:#334155;margin:0 0 16px;">Someone wants to work with you on Fonlok. Review the details below and create an invoice if interested.</p>
           ${emailTable([
             ["Name", sender_name],
             [
               "Email",
               `<a href="mailto:${sender_email}" style="color:#0F1F3D;">${sender_email}</a>`,
             ],
             ["Message", message],
           ])}
           <p style="color:#64748b;font-size:13px;margin:0 0 16px;">To continue, create an invoice in your dashboard and share the secure payment link with this buyer.</p>
           ${emailButton(`${FRONTEND_URL}/dashboard?action=create`, "Create Invoice")}`,
          {
            footerNote: `This request came from your public seller profile: ${profileUrl}`,
          },
        ),
      });

      return res.status(201).json({ ok: true });
    } catch (error) {
      console.log("deal-request error:", error.message);
      return res
        .status(500)
        .json({ message: "Failed to send deal request. Please try again." });
    }
  },
);

// ── PATCH /profile/bio-tags ──────────────────────────────────────────────────
// Authenticated sellers update their public bio and service tags.
router.patch(
  "/bio-tags",
  authMiddleware,
  [
    body("bio")
      .optional({ checkFalsy: true })
      .trim()
      .isLength({ max: 160 })
      .withMessage("Bio must be 160 characters or fewer."),
    body("tags")
      .optional()
      .isArray({ max: 10 })
      .withMessage("Max 10 tags allowed."),
    body("tags.*")
      .trim()
      .isLength({ min: 1, max: 40 })
      .withMessage("Each tag must be between 1 and 40 characters."),
  ],
  validate,
  async (req, res) => {
    const userId = req.user.id;
    const { bio, tags } = req.body;
    try {
      await db.query("UPDATE users SET bio = $1, tags = $2 WHERE id = $3", [
        bio || null,
        tags || [],
        userId,
      ]);
      return res
        .status(200)
        .json({ ok: true, bio: bio || null, tags: tags || [] });
    } catch (error) {
      console.log(error.message);
      return res
        .status(500)
        .json({ message: "Failed to save profile info. Please try again." });
    }
  },
);

// ── PATCH /profile/review/:id/pin ────────────────────────────────────────────
// Seller toggles pin status on one of their received reviews.
router.patch("/review/:id/pin", authMiddleware, async (req, res) => {
  const sellerId = req.user.id;
  const reviewId = parseInt(req.params.id, 10);
  if (isNaN(reviewId))
    return res.status(400).json({ message: "Invalid review ID." });
  try {
    // Verify the review belongs to this seller
    const check = await db.query(
      "SELECT id, pinned FROM reviews WHERE id = $1 AND seller_userid = $2",
      [reviewId, sellerId],
    );
    if (check.rows.length === 0)
      return res.status(404).json({ message: "Review not found." });
    const newPinned = !check.rows[0].pinned;
    await db.query("UPDATE reviews SET pinned = $1 WHERE id = $2", [
      newPinned,
      reviewId,
    ]);
    return res.status(200).json({ ok: true, pinned: newPinned });
  } catch (error) {
    console.log(error.message);
    return res
      .status(500)
      .json({ message: "Failed to update pin. Please try again." });
  }
});

// ── PATCH /profile/review/:id/reply ──────────────────────────────────────────
// Seller posts or updates a public reply to a review.
router.patch(
  "/review/:id/reply",
  authMiddleware,
  [
    body("reply")
      .trim()
      .notEmpty()
      .withMessage("Reply cannot be empty.")
      .isLength({ max: 800 })
      .withMessage("Reply must be 800 characters or fewer.")
      .escape(),
  ],
  validate,
  async (req, res) => {
    const sellerId = req.user.id;
    const reviewId = parseInt(req.params.id, 10);
    if (isNaN(reviewId))
      return res.status(400).json({ message: "Invalid review ID." });
    const { reply } = req.body;
    try {
      const check = await db.query(
        "SELECT id FROM reviews WHERE id = $1 AND seller_userid = $2",
        [reviewId, sellerId],
      );
      if (check.rows.length === 0)
        return res.status(404).json({ message: "Review not found." });
      await db.query(
        "UPDATE reviews SET seller_reply = $1, reply_created_at = NOW() WHERE id = $2",
        [reply, reviewId],
      );
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.log(error.message);
      return res
        .status(500)
        .json({ message: "Failed to save reply. Please try again." });
    }
  },
);

export default router;
