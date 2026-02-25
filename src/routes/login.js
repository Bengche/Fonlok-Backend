import express from "express";
const router = express.Router();
import db from "../controllers/db.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import { body } from "express-validator";
import { validate } from "../middleware/validate.js";
import logger from "../utils/logger.js";
router.use(cookieParser());

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
        "SELECT * FROM users WHERE email = $1 OR username = $2",
        [normalizedEmail, email],
      );
      if (result.rows.length === 0) {
        // Generic message — do NOT reveal whether the email/username exists.
        // A 401 (not 404) prevents account enumeration via status code.
        return res.status(401).json({ message: "Invalid email or password." });
      }
      const user = result.rows[0];
      const userPassword = user.password;
      const isMatch = await bcrypt.compare(password, userPassword);
      if (isMatch) {
        const token = jwt.sign(
          {
            id: user.id,
            normalizedEmail: user.normalizedEmail,
          },
          process.env.JWT_SECRET,
          { expiresIn: "6h" },
        );

        // Use BACKEND_URL to detect if we're actually on HTTPS.
        // NODE_ENV=production can be set locally (for logging etc.) without
        // having a real TLS cert, so using NODE_ENV for secure/sameSite causes
        // browsers to silently drop the cookie on plain-HTTP connections.
        const isHttps = process.env.BACKEND_URL?.startsWith("https");
        res.cookie("authToken", token, {
          httpOnly: true,
          secure: isHttps,
          sameSite: isHttps ? "none" : "lax",
          maxAge: 6 * 60 * 60 * 1000,
        });

        res.status(200).json({
          message: "Logged in successfully.",
          userId: user.id,
          username: user.username,
          token,
        });
        // Never log the token — anyone with log access could steal sessions.
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

export default router;
