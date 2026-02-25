import axios from "axios";
import express from "express";
import db from "../controllers/db.js";

import crypto from "crypto";
const router = express.Router();
import dotenv from "dotenv";
import { body } from "express-validator";
import { validate } from "../middleware/validate.js";

dotenv.config();

// POST: Trigger the MoMo/Orange prompt
router.post(
  "/requestPayment",
  [
    body("amount")
      .notEmpty()
      .withMessage("Payment amount is required.")
      .isFloat({ min: 1 })
      .withMessage("Amount must be a positive number."),
    // TODO: Re-enable minimum 500 XAF before going to production:
    // .isFloat({ min: 500 })
    // .withMessage("Amount must be at least 500 XAF."),

    body("phoneNumber")
      .trim()
      .notEmpty()
      .withMessage("Phone number is required.")
      .matches(/^237[62]\d{8}$/)
      .withMessage(
        "Enter a valid Cameroonian phone number (e.g. 2376XXXXXXXX).",
      ),

    body("email")
      .trim()
      .isEmail()
      .withMessage("A valid email address is required.")
      .normalizeEmail(),

    body("invoiceid").notEmpty().withMessage("Invoice ID is missing."),

    body("invoicenumber")
      .trim()
      .notEmpty()
      .withMessage("Invoice number is missing."),
  ],
  validate,
  async (req, res) => {
    const currency = "XAF";
    const {
      amount,
      phoneNumber,
      invoicename,
      invoicenumber,
      invoiceid,
      email,
      userid,
    } = req.body;
    // console.log(phoneNumber);

    // Example: phoneNumber = "23767..." or "237699..."
    const digit5 = phoneNumber.charAt(4);
    const digit6 = phoneNumber.charAt(5);

    let provider = "UNKNOWN";

    // 1. Direct MTN ranges (67, 68)
    if (digit5 === "7" || digit5 === "8") {
      provider = "MTN";
    }
    // 2. Direct Orange ranges (66)
    else if (digit5 === "6") {
      provider = "ORANGE";
    }
    // 3. The 69x Range (690-698 = Orange, 699 = MTN)
    else if (digit5 === "9") {
      provider = digit6 === "9" ? "MTN" : "ORANGE";
    }
    // 4. The 65x Range (650-654 = MTN, 655-659 = Orange)
    else if (digit5 === "5") {
      const d6 = parseInt(digit6);
      provider = d6 <= 4 ? "MTN" : "ORANGE";
    }

    console.log(`The provider is: ${provider}`);

    // Update or insert guest credentials

    // $1 and $2 are safe placeholders for variables

    try {
      // 1. Get an Authorization Token from Campay
      // Note: In production, use environment variables!
      const authResponse = await axios.post(
        "https://demo.campay.net/api/token/",
        {
          username: process.env.CAMPAY_USERNAME,
          password: process.env.CAMPAY_PASSWORD,
        },
      );

      const token = authResponse.data.token;
      let paymentUUID = crypto.randomUUID();
      // MUST be awaited — Campay fires its webhook almost immediately after
      // collect() returns.  If this INSERT hasn't committed yet the webhook
      // lookup fails → no email, no confirmation code, no chat link.
      await db.query(
        "INSERT INTO payments (invoiceid, provider, providerpaymentid, amount, currency) VALUES($1, $2, $3, $4, $5)",
        [invoiceid, provider, paymentUUID, amount, currency],
      );

      // Save buyer email + phone BEFORE calling Campay so the address is
      // captured even if the MoMo prompt fails (e.g. network error, wrong
      // number). This is the only source of buyer email for reminder emails.
      try {
        await db.query(
          `INSERT INTO guests (email, momo_number, user_id, invoicenumber)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (email, invoicenumber)
           DO UPDATE SET momo_number = EXCLUDED.momo_number,
                         user_id     = EXCLUDED.user_id`,
          [email, phoneNumber, userid, invoicenumber],
        );
      } catch (guestErr) {
        // Non-fatal — payment can still proceed even if guest save fails
        console.error("Could not save guest record:", guestErr.message);
      }

      // 2. Request Payment (Collect)
      const collectResponse = await axios.post(
        "https://demo.campay.net/api/collect/",
        {
          amount: amount, //only whole intergers, no float numbers
          currency: "XAF",
          from: phoneNumber, // e.g. "237670000000"
          description: `${invoicename}`,
          external_reference: paymentUUID, // This links the payment to your DB
          uuid: paymentUUID, //Must be unique for each request, to avoid idempotency...
        },
        {
          headers: {
            Authorization: `Token ${token}`,
            "Content-Type": "application/json",
          },
        },
      );

      // 3. Persist Campay's own reference so the poll endpoint can use it
      //    for GET /api/transaction/{reference}/ status checks.
      //    (Campay's reference !== our external_reference/UUID)
      const campayReference = collectResponse.data.reference;
      if (campayReference) {
        try {
          await db.query(
            "UPDATE payments SET campay_reference = $1 WHERE providerpaymentid = $2",
            [campayReference, paymentUUID],
          );
        } catch (refErr) {
          console.error("Could not save Campay reference:", refErr.message);
        }
      }

      // 4. Send the reference back to your Next.js frontend
      res.status(200).json({
        success: true,
        reference: campayReference,
        message:
          "Please Check your phone for the MoMo prompt, or dial *126#  or #150*50# to complete the payment.",
      });
    } catch (error) {
      console.error("Payment Error:", error.response?.data || error.message);
      res
        .status(500)
        .json({ success: false, error: "Failed to trigger payment" });
    }
  },
);

export default router;
