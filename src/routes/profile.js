import express from "express";
const router = express.Router();
import db from "../controllers/db.js";
import authMiddleware from "../middleware/authMiddleware.js";
import dotenv from "dotenv";
import { body } from "express-validator";
import { validate } from "../middleware/validate.js";
dotenv.config();

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
      "SELECT id, name, username, country, profilepicture, createdat, phone FROM users WHERE username = $1",
      [username],
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: "Seller not found." });
    }
    const seller = userResult.rows[0];

    // 2. Get all delivered/completed invoices for this seller
    // Status flow: paid → delivered (marked by seller) → completed (after payout)
    // We count both so stats reflect reality regardless of payout timing.
    const invoicesResult = await db.query(
      `SELECT invoicename, amount, currency, status, createdat, delivered_at
       FROM invoices
       WHERE userid = $1 AND status IN ('delivered', 'completed')
       ORDER BY delivered_at DESC`,
      [seller.id],
    );

    // 3. Get all reviews for this seller
    const reviewsResult = await db.query(
      `SELECT reviews.id, reviews.rating, reviews.comment, reviews.created_at,
              COALESCE(NULLIF(TRIM(users.name), ''), users.username) AS reviewer_name
       FROM reviews
       JOIN users ON users.id = reviews.reviewer_userid
       WHERE reviews.seller_userid = $1
       ORDER BY reviews.created_at DESC`,
      [seller.id],
    );

    // 4. Calculate average rating
    const avgResult = await db.query(
      "SELECT ROUND(AVG(rating), 1) AS average FROM reviews WHERE seller_userid = $1",
      [seller.id],
    );
    const averageRating = avgResult.rows[0].average || 0;

    // 5. Count total completed transactions (delivered invoices)
    const completedCount = invoicesResult.rows.length;

    return res.status(200).json({
      seller,
      completedInvoices: invoicesResult.rows,
      reviews: reviewsResult.rows,
      averageRating,
      completedCount,
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
// Authenticated buyers can leave a review after a completed transaction
router.post(
  "/review",
  authMiddleware,
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
  ],
  validate,
  async (req, res) => {
    const reviewerId = req.user.id;
    const { seller_username, invoice_number, rating, comment } = req.body;

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

      // 2. Make sure the invoice actually exists and is delivered or completed
      // Status flow: delivered = seller marked done, completed = payout was processed
      const invoiceCheck = await db.query(
        "SELECT * FROM invoices WHERE invoicenumber = $1 AND status IN ('delivered', 'completed')",
        [invoice_number],
      );
      if (invoiceCheck.rows.length === 0) {
        return res.status(403).json({
          message:
            "You can only leave a review for a completed and delivered invoice.",
        });
      }

      // 3. Make sure the reviewer was actually the buyer on this invoice
      const buyerCheck = await db.query(
        "SELECT * FROM guests WHERE invoicenumber = $1 AND user_id = $2",
        [invoice_number, reviewerId],
      );
      if (buyerCheck.rows.length === 0) {
        return res.status(403).json({
          message: "You can only review sellers for invoices you have paid.",
        });
      }

      // 4. Prevent duplicate reviews on the same invoice
      const duplicateCheck = await db.query(
        "SELECT * FROM reviews WHERE reviewer_userid = $1 AND invoice_number = $2",
        [reviewerId, invoice_number],
      );
      if (duplicateCheck.rows.length > 0) {
        return res.status(409).json({
          message: "You have already left a review for this transaction.",
        });
      }

      // 5. Save the review
      await db.query(
        "INSERT INTO reviews (reviewer_userid, seller_userid, invoice_number, rating, comment) VALUES ($1, $2, $3, $4, $5)",
        [reviewerId, sellerId, invoice_number, rating, comment],
      );

      return res
        .status(201)
        .json({ message: "Your review has been submitted. Thank you!" });
    } catch (error) {
      console.log(error.message);
      return res
        .status(500)
        .json({ message: "Failed to submit review. Please try again." });
    }
  },
);

export default router;
