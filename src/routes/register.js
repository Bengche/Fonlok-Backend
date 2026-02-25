import express from "express";
const router = express.Router();
import db from "../controllers/db.js";
import multer from "multer";
import bcrypt from "bcrypt";
import fs from "fs";
import path from "path";
import { body } from "express-validator";
import { validate } from "../middleware/validate.js";
const saltRounds = 10;

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

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "./uploads"),
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({
  storage,
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
    const profilePicture = req.file?.filename || null;

    const passwordHash = await bcrypt.hash(password, saltRounds);
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

      res.status(201).json({ ok: true });
      console.log(`✅ User Registered Successfully`);
    } catch (error) {
      console.log(error.message);
      res
        .status(500)
        .json({ message: "Failed to register user. Please try again." });
    }
  },
);

export default router;
