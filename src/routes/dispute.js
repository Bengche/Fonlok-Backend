import express from "express";
const router = express.Router();
import db from "../controllers/db.js";
import dotenv from "dotenv";
import crypto from "crypto";
import sgMail from "@sendgrid/mail";
import axios from "axios";
import { body } from "express-validator";
import { validate } from "../middleware/validate.js";
import { notifyUser } from "../middleware/notificationHelper.js";
import {
  emailWrap,
  emailTable,
  emailButton,
  emailButtonDanger,
} from "../utils/emailTemplate.js";
dotenv.config();

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// --- HELPER: Verify that a buyer's chat_token matches the invoice ---
const verifyBuyerToken = async (invoicenumber, token) => {
  const result = await db.query(
    "SELECT * FROM guests WHERE invoicenumber = $1 AND chat_token = $2",
    [invoicenumber, token],
  );
  return result.rows[0] || null;
};

// ------------------------------------------------------------
// ROUTE 1: OPEN A DISPUTE
// Seller calls: POST /dispute/open/:invoicenumber  { reason, opened_by: "seller" }
// Buyer calls:  POST /dispute/open/:invoicenumber  { reason, opened_by: "buyer", token: "buyer_chat_token" }
// ------------------------------------------------------------
router.post(
  "/open/:invoicenumber",
  [
    body("reason")
      .trim()
      .notEmpty()
      .withMessage("A reason for the dispute is required.")
      .isLength({ max: 1000 })
      .withMessage("Reason must be 1000 characters or fewer.")
      .escape(),

    body("opened_by")
      .trim()
      .isIn(["seller", "buyer"])
      .withMessage("Dispute must be opened by either 'seller' or 'buyer'."),

    body("token").optional({ checkFalsy: true }).trim(),
  ],
  validate,
  async (req, res) => {
    const { invoicenumber } = req.params;
    const { reason, opened_by, token } = req.body;

    try {
      // 1. Get the invoice
      const invoiceResult = await db.query(
        "SELECT * FROM invoices WHERE invoicenumber = $1",
        [invoicenumber],
      );
      if (invoiceResult.rows.length === 0) {
        return res.status(404).json({ message: "Invoice not found." });
      }
      const invoice = invoiceResult.rows[0];

      // 2. Only allow disputes if the buyer has already paid
      if (invoice.status !== "paid" && invoice.status !== "delivered") {
        return res.status(403).json({
          message:
            "A dispute can only be opened after a payment has been made.",
        });
      }

      // 3. If seller is opening, check the 48-hour rule after marking as delivered
      if (opened_by === "seller") {
        if (invoice.status !== "delivered") {
          return res.status(403).json({
            message:
              "You can only open a dispute after you have marked the invoice as delivered.",
          });
        }

        // Check that at least 48 hours have passed since delivery
        const deliveredAt = new Date(invoice.delivered_at);
        const now = new Date();
        const hoursSinceDelivery = (now - deliveredAt) / (1000 * 60 * 60);

        if (hoursSinceDelivery < 48) {
          const hoursLeft = Math.ceil(48 - hoursSinceDelivery);
          return res.status(403).json({
            message: `You can open a dispute ${hoursLeft} hour(s) from now. This gives the buyer fair time to confirm delivery.`,
          });
        }
      }

      // 4. If buyer is opening, verify their token
      if (opened_by === "buyer") {
        const guest = await verifyBuyerToken(invoicenumber, token);
        if (!guest) {
          return res
            .status(401)
            .json({ message: "Invalid token. Access denied." });
        }
      }

      // 5. Check that a dispute does not already exist for this invoice
      const existingDispute = await db.query(
        "SELECT * FROM disputes WHERE invoicenumber = $1",
        [invoicenumber],
      );
      if (existingDispute.rows.length > 0) {
        const existing = existingDispute.rows[0];
        if (existing.status === "open") {
          return res.status(409).json({
            message:
              "A dispute is already open for this invoice. Our admin will review it shortly.",
          });
        }
        if (existing.status !== "open") {
          return res.status(409).json({
            message:
              "This invoice has already been through a dispute process and was resolved.",
          });
        }
      }

      // 6. Generate a secret token for the admin's moderator link
      const adminToken = crypto.randomBytes(32).toString("hex");

      // 7. Save the dispute to the database
      await db.query(
        "INSERT INTO disputes (invoiceid, invoicenumber, opened_by, reason, admin_token) VALUES ($1, $2, $3, $4, $5)",
        [invoice.id, invoicenumber, opened_by, reason, adminToken],
      );

      // 8. Add a system message to the chat so both parties can see the dispute was opened
      const chatResult = await db.query(
        "SELECT * FROM chats WHERE invoicenumber = $1",
        [invoicenumber],
      );
      if (chatResult.rows.length > 0) {
        await db.query(
          "INSERT INTO messages (chat_id, sender_type, sender_email, message) VALUES ($1, $2, $3, $4)",
          [
            chatResult.rows[0].id,
            "system",
            "system",
            `⚠️ A dispute has been opened by the ${opened_by}. Reason: "${reason}". An admin has been notified and will review this conversation.`,
          ],
        );
      }

      // 9. Build the admin moderator link
      const adminLink = `${process.env.FRONTEND_URL}/admin/dispute/${adminToken}`;

      // 10. Email the admin
      const adminEmailMsg = {
        to: process.env.ADMIN_EMAIL,
        from: process.env.VERIFIED_SENDER,
        subject: `[Admin] New Dispute Opened  - Invoice ${invoicenumber} | Fonlok`,
        html: emailWrap(
          `<h2 style="color:#0F1F3D;margin:0 0 12px;">New Dispute Opened &mdash; Invoice ${invoicenumber}</h2>
          <p style="color:#475569;">A dispute has been opened and requires your review.</p>
          ${emailTable([
            ["Invoice Number", invoicenumber],
            ["Invoice Name", invoice.invoicename],
            [
              "Amount",
              `${invoice.amount} ${invoice.currency}`,
              "font-weight:700;font-size:15px;",
            ],
            ["Opened By", opened_by],
            ["Reason", reason],
          ])}
          <p style="color:#475569;">Click the button below to join the chat, review all messages and make a decision.</p>
          ${emailButtonDanger(adminLink, "Review Dispute &amp; Join Chat")}`,
          {
            subtitle: "Admin Notification",
            footerNote:
              "Keep this link private &mdash; it gives admin access to the dispute chat.",
          },
        ),
      };

      try {
        await sgMail.send(adminEmailMsg);
        console.log("✅ Admin dispute notification email sent.");
      } catch (emailError) {
        console.error(
          "❌ Admin Email Error:",
          emailError.response ? emailError.response.body : emailError.message,
        );
      }

      // 11. Fetch buyer email for party notifications
      const buyerEmailResult = await db.query(
        "SELECT email FROM guests WHERE invoicenumber = $1 ORDER BY id DESC LIMIT 1",
        [invoicenumber],
      );
      const buyerEmail = buyerEmailResult.rows[0]?.email || null;
      const sellerEmail = invoice.clientemail;
      const chatLink = `${process.env.FRONTEND_URL}/chat/${invoicenumber}`;
      const invoicePageLink = `${process.env.FRONTEND_URL}/invoice/${invoicenumber}`;

      // 12. Email the seller
      if (sellerEmail) {
        const isSellerOpener = opened_by === "seller";
        const sellerDisputeMsg = {
          to: sellerEmail,
          from: process.env.VERIFIED_SENDER,
          subject: isSellerOpener
            ? `Your Dispute Has Been Filed  - Invoice ${invoicenumber} | Fonlok`
            : `A Buyer Has Opened a Dispute on Your Invoice | Fonlok`,
          html: emailWrap(
            `<h2 style="color:#0F1F3D;margin:0 0 12px;">${
              isSellerOpener
                ? "Your Dispute Has Been Submitted"
                : "A Buyer Has Opened a Dispute"
            }</h2>
            <p style="color:#475569;">${
              isSellerOpener
                ? "We have received your dispute request. Our admin team will review all messages and make a fair decision within <strong>24 -48 hours</strong>."
                : "A buyer has filed a dispute on one of your invoices. Our admin team has been notified and will review the case within <strong>24 -48 hours</strong>."
            }</p>
            ${emailTable([
              ["Invoice Number", invoicenumber],
              ["Invoice Name", invoice.invoicename],
              [
                "Amount",
                `${invoice.amount} ${invoice.currency}`,
                "font-weight:700;font-size:15px;",
              ],
              ["Opened By", isSellerOpener ? "You (seller)" : "Buyer"],
              ["Reason", reason],
            ])}
            <p style="color:#475569;">You can view the full conversation and track the dispute resolution in the chat thread.</p>
            ${emailButton(chatLink, "View Dispute Chat")}`,
            {
              subtitle: "Dispute Notification",
              footerNote:
                "Please do not attempt to pressure the other party. All disputes are reviewed and resolved fairly by Fonlok admin.",
            },
          ),
        };
        try {
          await sgMail.send(sellerDisputeMsg);
          console.log("✅ Seller dispute notification email sent.");
        } catch (e) {
          console.error(
            "❌ Seller dispute email error:",
            e.response?.body ?? e.message,
          );
        }
      }

      // 13. Email the buyer
      if (buyerEmail) {
        const isBuyerOpener = opened_by === "buyer";
        const buyerDisputeMsg = {
          to: buyerEmail,
          from: process.env.VERIFIED_SENDER,
          subject: isBuyerOpener
            ? `Your Dispute Has Been Filed  - Invoice ${invoicenumber} | Fonlok`
            : `A Dispute Has Been Opened on Your Purchase | Fonlok`,
          html: emailWrap(
            `<h2 style="color:#0F1F3D;margin:0 0 12px;">${
              isBuyerOpener
                ? "Your Dispute Has Been Submitted"
                : "A Dispute Has Been Opened on Your Purchase"
            }</h2>
            <p style="color:#475569;">${
              isBuyerOpener
                ? "We have received your dispute request. Our admin team will review all messages and make a fair decision within <strong>24 -48 hours</strong>."
                : "The seller has filed a dispute regarding your purchase. Our admin team has been notified and will review the case within <strong>24 -48 hours</strong>."
            }</p>
            ${emailTable([
              ["Invoice Number", invoicenumber],
              ["Invoice Name", invoice.invoicename],
              [
                "Amount",
                `${invoice.amount} ${invoice.currency}`,
                "font-weight:700;font-size:15px;",
              ],
              ["Opened By", isBuyerOpener ? "You (buyer)" : "Seller"],
              ["Reason", reason],
            ])}
            <p style="color:#475569;">Your funds are safely held in escrow and will not be released until the dispute is resolved.</p>
            ${emailButton(invoicePageLink, "View Invoice &amp; Chat")}`,
            {
              subtitle: "Dispute Notification",
              footerNote:
                "Please do not attempt to pressure the other party. All disputes are reviewed and resolved fairly by Fonlok admin.",
            },
          ),
        };
        try {
          await sgMail.send(buyerDisputeMsg);
          console.log("✅ Buyer dispute notification email sent.");
        } catch (e) {
          console.error(
            "❌ Buyer dispute email error:",
            e.response?.body ?? e.message,
          );
        }
      }

      // Notify the seller if the buyer opened the dispute
      if (opened_by === "buyer") {
        notifyUser(
          invoice.userid,
          "dispute_opened",
          "Dispute Opened",
          `A buyer has opened a dispute on invoice "${invoice.invoicename}". Reason: "${reason}". An admin will review shortly.`,
          { invoiceNumber: invoicenumber, reason },
        );
      }

      return res.status(200).json({
        message:
          "Dispute opened successfully. Our admin has been notified and will review your case shortly.",
      });
    } catch (error) {
      console.log(error.message);
      return res
        .status(500)
        .json({ message: "Something went wrong. Please try again." });
    }
  },
);

// ------------------------------------------------------------
// ROUTE 2: ADMIN VIEWS THE DISPUTE (via their secret link)
// GET /dispute/admin/:admin_token
// Returns the dispute info, invoice info, and all chat messages
// ------------------------------------------------------------
router.get("/admin/:admin_token", async (req, res) => {
  const { admin_token } = req.params;

  try {
    // 1. Find the dispute by the admin token
    const disputeResult = await db.query(
      "SELECT * FROM disputes WHERE admin_token = $1",
      [admin_token],
    );
    if (disputeResult.rows.length === 0) {
      return res
        .status(404)
        .json({ message: "Invalid admin link. Dispute not found." });
    }

    const dispute = disputeResult.rows[0];

    // 2. Get the invoice details
    const invoiceResult = await db.query(
      "SELECT * FROM invoices WHERE invoicenumber = $1",
      [dispute.invoicenumber],
    );
    const invoice = invoiceResult.rows[0];

    // 3. Get the buyer info from guests table
    const guestResult = await db.query(
      "SELECT * FROM guests WHERE invoicenumber = $1",
      [dispute.invoicenumber],
    );
    const buyer = guestResult.rows[0] || null;

    // 4. Get seller info
    const sellerResult = await db.query(
      "SELECT name, email, phone FROM users WHERE id = $1",
      [invoice.userid],
    );
    const seller = sellerResult.rows[0] || null;

    // 5. Get all chat messages for this invoice
    const chatResult = await db.query(
      "SELECT * FROM chats WHERE invoicenumber = $1",
      [dispute.invoicenumber],
    );
    let messages = [];
    if (chatResult.rows.length > 0) {
      const messagesResult = await db.query(
        "SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC",
        [chatResult.rows[0].id],
      );
      messages = messagesResult.rows;
    }

    return res.status(200).json({
      dispute,
      invoice,
      buyer,
      seller,
      messages,
    });
  } catch (error) {
    console.log(error.message);
    return res.status(500).json({ message: "Something went wrong." });
  }
});

// ------------------------------------------------------------
// ROUTE 3: ADMIN SENDS A MESSAGE IN THE CHAT AS MODERATOR
// POST /dispute/admin/:admin_token/message  { message }
// ------------------------------------------------------------
router.post(
  "/admin/:admin_token/message",
  [
    body("message")
      .trim()
      .notEmpty()
      .withMessage("Message cannot be empty.")
      .isLength({ max: 2000 })
      .withMessage("Message must be 2000 characters or fewer.")
      .escape(),
  ],
  validate,
  async (req, res) => {
    const { admin_token } = req.params;
    const { message } = req.body;

    try {
      // Verify admin token
      const disputeResult = await db.query(
        "SELECT * FROM disputes WHERE admin_token = $1",
        [admin_token],
      );
      if (disputeResult.rows.length === 0) {
        return res.status(404).json({ message: "Invalid admin link." });
      }

      const dispute = disputeResult.rows[0];

      // Get the chat room
      const chatResult = await db.query(
        "SELECT * FROM chats WHERE invoicenumber = $1",
        [dispute.invoicenumber],
      );
      if (chatResult.rows.length === 0) {
        return res.status(404).json({ message: "Chat room not found." });
      }

      // Save the admin message
      const newMessage = await db.query(
        "INSERT INTO messages (chat_id, sender_type, sender_email, message) VALUES ($1, $2, $3, $4) RETURNING *",
        [chatResult.rows[0].id, "moderator", process.env.ADMIN_EMAIL, message],
      );

      return res.status(200).json({ message: newMessage.rows[0] });
    } catch (error) {
      console.log(error.message);
      return res.status(500).json({ message: "Something went wrong." });
    }
  },
);

// ------------------------------------------------------------
// ROUTE 4: ADMIN RESOLVES THE DISPUTE
// POST /dispute/admin/:admin_token/resolve  { decision: "seller" or "buyer" }
// "seller" = release funds to the seller
// "buyer"  = refund the buyer
// ------------------------------------------------------------
router.post(
  "/admin/:admin_token/resolve",
  [
    body("decision")
      .trim()
      .isIn(["seller", "buyer"])
      .withMessage("Decision must be 'seller' or 'buyer'."),
  ],
  validate,
  async (req, res) => {
    const { admin_token } = req.params;
    const { decision } = req.body; // "seller" or "buyer"

    try {
      // 1. Verify admin token and get the dispute
      const disputeResult = await db.query(
        "SELECT * FROM disputes WHERE admin_token = $1",
        [admin_token],
      );
      if (disputeResult.rows.length === 0) {
        return res.status(404).json({ message: "Invalid admin link." });
      }

      const dispute = disputeResult.rows[0];

      if (dispute.status !== "open") {
        return res
          .status(400)
          .json({ message: "This dispute has already been resolved." });
      }

      // 2. Get the invoice
      const invoiceResult = await db.query(
        "SELECT * FROM invoices WHERE invoicenumber = $1",
        [dispute.invoicenumber],
      );
      const invoice = invoiceResult.rows[0];

      // 3. Get the chat to post a system message
      const chatResult = await db.query(
        "SELECT * FROM chats WHERE invoicenumber = $1",
        [dispute.invoicenumber],
      );

      if (decision === "seller") {
        // --- DECISION: Release funds to the seller ---

        // Get Campay token
        const auth = await axios.post(`${process.env.CAMPAY_BASE_URL}token/`, {
          username: process.env.CAMPAY_USERNAME,
          password: process.env.CAMPAY_PASSWORD,
        });

        // Get seller info
        const sellerResult = await db.query(
          "SELECT * FROM users WHERE id = $1",
          [invoice.userid],
        );
        const seller = sellerResult.rows[0];

        // ── Fee calculation with referral split ─────────────────────────────
        // Identical logic to the three payout paths: seller always receives
        // gross − 2%. If the seller was referred, the referrer gets 0.5% and
        // Fonlok keeps 1.5%; otherwise Fonlok keeps the full 2%.
        const DISPUTE_TOTAL_FEE_RATE = 0.02;
        const DISPUTE_REFERRAL_FEE_RATE = 0.005;

        const grossAmountD = Number(invoice.amount);
        const referrerCheckD = await db.query(
          "SELECT referred_by FROM users WHERE id = $1",
          [invoice.userid],
        );
        const referrerIdD = referrerCheckD.rows[0]?.referred_by ?? null;
        const hasReferralD = referrerIdD !== null;

        const totalFeeD = Math.floor(grossAmountD * DISPUTE_TOTAL_FEE_RATE); // 2%
        const referralEarningD = hasReferralD
          ? Math.floor(grossAmountD * DISPUTE_REFERRAL_FEE_RATE) // 0.5%
          : 0;
        const fonlokNetD = totalFeeD - referralEarningD; // 1.5% or 2%
        const sellerShare = grossAmountD - totalFeeD; // gross − 2%

        console.log(
          `Dispute payout ${invoice.invoicenumber}: gross=${grossAmountD}, ` +
            `totalFee=${totalFeeD}, fonlokNet=${fonlokNetD}, ` +
            `referralEarning=${referralEarningD}, sellerReceives=${sellerShare}`,
        );

        // Send payout to seller
        await axios.post(
          `${process.env.CAMPAY_BASE_URL}withdraw/`,
          {
            amount: sellerShare.toString(),
            currency: "XAF",
            to: seller.phone,
            description: `Dispute resolved - payout for invoice ${invoice.invoicenumber}`,
            external_reference: invoice.invoicenumber,
          },
          { headers: { Authorization: `Token ${auth.data.token}` } },
        );

        // Update invoice and dispute status
        await db.query(
          "UPDATE invoices SET status = 'completed' WHERE id = $1",
          [invoice.id],
        );
        await db.query(
          "UPDATE disputes SET status = 'resolved_seller' WHERE admin_token = $1",
          [admin_token],
        );
        await db.query(
          "INSERT INTO payouts (userid, amount, method, status, invoice_id, invoice_number) VALUES ($1, $2, $3, $4, $5, $6)",
          [
            invoice.userid,
            sellerShare,
            "Mobile Money",
            "paid",
            invoice.id,
            invoice.invoicenumber,
          ],
        );

        // ── Credit referral earnings &mdash; INSERT first, balance only if new ─────
        if (hasReferralD && referralEarningD > 0) {
          try {
            const dEarningsInsert = await db.query(
              `INSERT INTO referral_earnings
                 (referrer_userid, referred_userid, invoice_number, invoice_amount, earned_amount)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (invoice_number) DO NOTHING
               RETURNING id`,
              [
                referrerIdD,
                invoice.userid,
                invoice.invoicenumber,
                grossAmountD,
                referralEarningD,
              ],
            );
            if (dEarningsInsert.rows.length > 0) {
              await db.query(
                "UPDATE users SET referral_balance = referral_balance + $1 WHERE id = $2",
                [referralEarningD, referrerIdD],
              );
              console.log(
                `✅ Dispute referral earning of ${referralEarningD} XAF (0.5%) credited to user ${referrerIdD}.`,
              );
            }
          } catch (referralErr) {
            console.error(
              "⚠️ Dispute referral credit error (payout still succeeded):",
              referralErr.message,
            );
          }
        }

        // Post system message in chat
        if (chatResult.rows.length > 0) {
          await db.query(
            "INSERT INTO messages (chat_id, sender_type, sender_email, message) VALUES ($1, $2, $3, $4)",
            [
              chatResult.rows[0].id,
              "system",
              "system",
              `✅ Dispute resolved by admin. Decision: Funds have been released to the seller.`,
            ],
          );
        }

        // Email the seller
        const sellerMsg = {
          to: seller.email,
          from: process.env.VERIFIED_SENDER,
          subject: `Dispute Resolved: Funds Released to You  - Invoice ${invoice.invoicenumber} | Fonlok`,
          html: emailWrap(
            `<h2 style="color:#0F1F3D;margin:0 0 12px;">Dispute Resolved &mdash; Funds Released to You</h2>
            <p style="color:#475569;">Hello ${seller.name}, the admin has reviewed the dispute for invoice <strong>${invoice.invoicenumber}</strong> and has decided to release the funds to you.</p>
            ${emailTable([
              ["Invoice", invoice.invoicenumber],
              [
                "Amount Sent",
                `${sellerShare} XAF`,
                "font-weight:700;color:#16a34a;font-size:15px;",
              ],
              ["Sent To", seller.phone],
            ])}`,
            {
              footerNote:
                "Thank you for using Fonlok. This email confirms the dispute resolution in your favour.",
            },
          ),
        };
        await sgMail
          .send(sellerMsg)
          .catch((e) => console.error("Seller email error:", e.message));

        // Email the buyer
        const guestResult = await db.query(
          "SELECT * FROM guests WHERE invoicenumber = $1",
          [invoice.invoicenumber],
        );
        if (guestResult.rows.length > 0) {
          const buyerMsg = {
            to: guestResult.rows[0].email,
            from: process.env.VERIFIED_SENDER,
            subject: `Dispute Update: Decision Issued  - Invoice ${invoice.invoicenumber} | Fonlok`,
            html: emailWrap(
              `<h2 style="color:#0F1F3D;margin:0 0 12px;">Dispute Resolved</h2>
              <p style="color:#475569;">The admin has reviewed the dispute for invoice <strong>${invoice.invoicenumber}</strong> and has decided to release the funds to the seller.</p>
              <p style="color:#475569;">If you believe this decision was unfair, please contact our support team at <a href="mailto:support@fonlok.com" style="color:#F59E0B;">support@fonlok.com</a>.</p>`,
              {
                footerNote:
                  "You received this email because a dispute was resolved on Fonlok Escrow. Contact support@fonlok.com with any concerns.",
              },
            ),
          };
          await sgMail
            .send(buyerMsg)
            .catch((e) => console.error("Buyer email error:", e.message));
        }

        return res
          .status(200)
          .json({ message: "Dispute resolved. Funds released to seller." });
      } else if (decision === "buyer") {
        // --- DECISION: Refund the buyer (buyer pays the 2% Fonlok fee) ---
        //
        // The buyer receives: invoice.amount − 2% (they bear the platform fee).
        // The refund is sent to the same MoMo number the buyer originally paid from,
        // which is stored in guests.momo_number.

        // 1. Get buyer record (need momo_number for the Campay withdraw)
        const guestResult = await db.query(
          "SELECT * FROM guests WHERE invoicenumber = $1",
          [invoice.invoicenumber],
        );
        const buyer = guestResult.rows[0] ?? null;

        if (!buyer?.momo_number) {
          return res.status(400).json({
            message:
              "Cannot process refund: no buyer payment number found for this invoice. " +
              "Please process the refund manually.",
          });
        }

        // 2. Calculate refund &mdash; buyer pays the 2% Fonlok fee
        const grossAmountB = Number(invoice.amount);
        const fonlokFeeB = Math.floor(grossAmountB * 0.02); // 2% platform fee
        const refundAmount = grossAmountB - fonlokFeeB; // buyer receives 98%

        console.log(
          `Dispute refund ${invoice.invoicenumber}: gross=${grossAmountB}, ` +
            `fonlokFee=${fonlokFeeB}, refundTobuyer=${refundAmount}`,
        );

        // 3. Campay auth + withdraw to buyer's original MoMo number
        const authB = await axios.post(`${process.env.CAMPAY_BASE_URL}token/`, {
          username: process.env.CAMPAY_USERNAME,
          password: process.env.CAMPAY_PASSWORD,
        });

        await axios.post(
          `${process.env.CAMPAY_BASE_URL}withdraw/`,
          {
            amount: refundAmount.toString(),
            currency: "XAF",
            to: buyer.momo_number,
            description: `Dispute refund for invoice ${invoice.invoicenumber}`,
            external_reference: `refund-${invoice.invoicenumber}`,
          },
          { headers: { Authorization: `Token ${authB.data.token}` } },
        );

        // 4. Mark invoice as refunded and dispute as resolved
        await db.query(
          "UPDATE invoices SET status = 'refunded' WHERE id = $1",
          [invoice.id],
        );
        await db.query(
          "UPDATE disputes SET status = 'resolved_buyer' WHERE admin_token = $1",
          [admin_token],
        );

        // 5. Record the refund payout
        await db.query(
          "INSERT INTO payouts (userid, amount, method, status, invoice_id, invoice_number) VALUES ($1, $2, $3, $4, $5, $6)",
          [
            invoice.userid,
            refundAmount,
            "Refund to Buyer",
            "refunded",
            invoice.id,
            invoice.invoicenumber,
          ],
        );

        // 6. Post system message in chat
        if (chatResult.rows.length > 0) {
          await db.query(
            "INSERT INTO messages (chat_id, sender_type, sender_email, message) VALUES ($1, $2, $3, $4)",
            [
              chatResult.rows[0].id,
              "system",
              "system",
              `✅ Dispute resolved by admin. Decision: Refund of ${refundAmount} XAF processed to the buyer's MoMo account.`,
            ],
          );
        }

        // 7. Email the buyer confirming the refund with exact amounts
        if (buyer.email) {
          const buyerRefundMsg = {
            to: buyer.email,
            from: process.env.VERIFIED_SENDER,
            subject: `Refund Processed  - Invoice ${invoice.invoicenumber} | Fonlok`,
            html: emailWrap(
              `<h2 style="color:#0F1F3D;margin:0 0 12px;">Refund Processed &mdash; Funds Sent to You</h2>
              <p style="color:#475569;">The admin has reviewed the dispute for invoice <strong>${invoice.invoicenumber}</strong> and your refund has been processed.</p>
              ${emailTable([
                ["Invoice", invoice.invoicenumber],
                ["Gross Amount Paid", `${grossAmountB} XAF`],
                ["Fonlok Fee (2%)", `−${fonlokFeeB} XAF`, "color:#dc2626;"],
                [
                  "Refund Sent to You",
                  `${refundAmount} XAF`,
                  "font-weight:700;color:#16a34a;font-size:15px;",
                ],
                ["Sent To", buyer.momo_number],
              ])}
              <p style="color:#475569;">The refund has been sent to your MoMo number. It should arrive within a few minutes.</p>`,
              {
                footerNote:
                  "You received this email because a dispute was resolved in your favour on Fonlok Escrow.",
              },
            ),
          };
          await sgMail
            .send(buyerRefundMsg)
            .catch((e) =>
              console.error("Buyer refund email error:", e.message),
            );
        }

        // 8. Email the seller about the outcome
        const sellerResultB = await db.query(
          "SELECT * FROM users WHERE id = $1",
          [invoice.userid],
        );
        if (sellerResultB.rows.length > 0) {
          const sellerRefundMsg = {
            to: sellerResultB.rows[0].email,
            from: process.env.VERIFIED_SENDER,
            subject: `Dispute Resolved: Refund Issued to Buyer  - Invoice ${invoice.invoicenumber} | Fonlok`,
            html: emailWrap(
              `<h2 style="color:#0F1F3D;margin:0 0 12px;">Dispute Resolved &mdash; Refund Issued to Buyer</h2>
              <p style="color:#475569;">Hello ${sellerResultB.rows[0].name}, the admin has reviewed the dispute for invoice <strong>${invoice.invoicenumber}</strong> and has decided to refund the buyer.</p>
              <p style="color:#475569;">If you believe this decision was unfair, please contact our support team at <a href="mailto:support@fonlok.com" style="color:#F59E0B;">support@fonlok.com</a>.</p>`,
              {
                footerNote:
                  "You received this email because a dispute was resolved on Fonlok Escrow. Contact support@fonlok.com with any concerns.",
              },
            ),
          };
          await sgMail
            .send(sellerRefundMsg)
            .catch((e) =>
              console.error("Seller refund email error:", e.message),
            );
        }

        return res.status(200).json({
          message: `Dispute resolved. Refund of ${refundAmount} XAF has been sent to the buyer's MoMo account.`,
        });
      } else {
        return res
          .status(400)
          .json({ message: "Invalid decision. Must be 'seller' or 'buyer'." });
      }
    } catch (error) {
      console.log(error.message);
      return res
        .status(500)
        .json({ message: "Something went wrong. Please try again." });
    }
  },
);

export default router;
