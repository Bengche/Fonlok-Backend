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
import { buildEmailCopy } from "../utils/emailLanguageCopy.js";
import { getUserEmailLanguageByEmail } from "../utils/userLanguage.js";
import { deliverWebhookEvent } from "./v1.js";
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

    body("dispute_scope")
      .optional()
      .trim()
      .isIn(["full", "milestone"])
      .withMessage("dispute_scope must be 'full' or 'milestone'."),

    body("milestone_ids")
      .optional()
      .isArray({ min: 1 })
      .withMessage("milestone_ids must be a non-empty array when provided."),

    body("milestone_ids.*")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Each milestone_id must be a positive integer."),
  ],
  validate,
  async (req, res) => {
    const { invoicenumber } = req.params;
    const { reason, opened_by, token, dispute_scope, milestone_ids } = req.body;

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

      // 3. If seller is opening, check delivery status and 48-hour rule
      if (opened_by === "seller") {
        const isMilestoneInvoice = invoice.payment_type === "installment";

        if (isMilestoneInvoice) {
          // Milestone invoice: allow dispute if at least one milestone has been
          // marked as delivered (status = 'completed') by the seller.
          const msRes = await db.query(
            "SELECT * FROM invoice_milestones WHERE invoice_id = $1 ORDER BY milestone_number ASC",
            [invoice.id],
          );
          const completedMs = msRes.rows.filter(
            (m) => m.status === "completed",
          );

          if (completedMs.length === 0) {
            return res.status(403).json({
              message:
                "You can only open a dispute after you have marked at least one milestone as delivered.",
            });
          }

          // 48-hour check: use the specific disputed milestones if provided,
          // otherwise fall back to all completed milestones (oldest first).
          let relevantMs = completedMs;
          if (Array.isArray(milestone_ids) && milestone_ids.length > 0) {
            const requestedIds = milestone_ids.map((id) => parseInt(id, 10));
            const targeted = completedMs.filter((m) =>
              requestedIds.includes(m.id),
            );
            if (targeted.length > 0) relevantMs = targeted;
          }

          // Find the milestone that has been waiting the longest
          const oldestCompleted = relevantMs.reduce((oldest, m) => {
            if (!oldest) return m;
            return new Date(m.completed_at) < new Date(oldest.completed_at)
              ? m
              : oldest;
          }, null);

          if (oldestCompleted && oldestCompleted.completed_at) {
            const completedAt = new Date(oldestCompleted.completed_at);
            const hoursSince =
              (Date.now() - completedAt.getTime()) / (1000 * 60 * 60);
            if (hoursSince < 48) {
              const hoursLeft = Math.ceil(48 - hoursSince);
              return res.status(403).json({
                message: `You can open a dispute ${hoursLeft} hour(s) from now. This gives the buyer fair time to confirm the milestone.`,
              });
            }
          }
        } else {
          // Regular (non-milestone) invoice: must be marked as delivered first
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

      // 6. Milestone-scope validation (milestone invoices only)
      // Block disputes on already-fully-released invoices, and validate
      // any specific milestone IDs the opener wants to dispute.
      const isMilestoneInvoice = invoice.payment_type === "installment";
      let finalScope = "full";
      let finalMilestoneIds = [];
      let disputedAmount = Number(invoice.amount);

      if (isMilestoneInvoice) {
        const msResult = await db.query(
          "SELECT * FROM invoice_milestones WHERE invoice_id = $1 ORDER BY milestone_number ASC",
          [invoice.id],
        );
        const milestones = msResult.rows;
        const releasedMs = milestones.filter((m) => m.status === "released");
        const unreleasedMs = milestones.filter((m) => m.status !== "released");

        if (unreleasedMs.length === 0) {
          return res.status(400).json({
            message:
              "All milestones on this invoice have already been released. There are no escrowed funds to dispute.",
          });
        }

        const requestedScope = dispute_scope || "full";

        if (requestedScope === "full") {
          if (releasedMs.length > 0) {
            return res.status(400).json({
              message:
                `${releasedMs.length} milestone(s) have already been paid out and cannot be included. ` +
                "Please select 'milestone' scope and choose only the unreleased milestones.",
              released_milestone_ids: releasedMs.map((m) => m.id),
              unreleased_milestone_ids: unreleasedMs.map((m) => m.id),
            });
          }
          finalScope = "full";
          finalMilestoneIds = unreleasedMs.map((m) => m.id);
          disputedAmount = unreleasedMs.reduce(
            (s, m) => s + Number(m.amount),
            0,
          );
        } else {
          // scope === 'milestone'
          if (
            !milestone_ids ||
            !Array.isArray(milestone_ids) ||
            milestone_ids.length === 0
          ) {
            return res.status(400).json({
              message: "Please select at least one milestone to dispute.",
            });
          }
          const requestedIds = milestone_ids.map((id) => parseInt(id, 10));
          const allIds = milestones.map((m) => m.id);
          const unknownIds = requestedIds.filter((id) => !allIds.includes(id));
          if (unknownIds.length > 0) {
            return res.status(400).json({
              message: `Milestone ID(s) [${unknownIds.join(", ")}] do not belong to this invoice.`,
            });
          }
          const alreadyReleased = milestones.filter(
            (m) => requestedIds.includes(m.id) && m.status === "released",
          );
          if (alreadyReleased.length > 0) {
            return res.status(400).json({
              message:
                `Milestone(s) [${alreadyReleased.map((m) => m.milestone_label || m.id).join(", ")}] ` +
                "have already been paid out and cannot be disputed.",
              already_released_ids: alreadyReleased.map((m) => m.id),
            });
          }
          finalScope = "milestone";
          finalMilestoneIds = requestedIds;
          const selectedMs = milestones.filter((m) =>
            requestedIds.includes(m.id),
          );
          disputedAmount = selectedMs.reduce((s, m) => s + Number(m.amount), 0);
        }
      }

      // 7. Generate a secret token for the admin's moderator link
      const adminToken = crypto.randomBytes(32).toString("hex");

      // 8. Save the dispute to the database (with scope metadata)
      await db.query(
        "INSERT INTO disputes (invoiceid, invoicenumber, opened_by, reason, admin_token, dispute_scope, disputed_milestone_ids, disputed_amount) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [
          invoice.id,
          invoicenumber,
          opened_by,
          reason,
          adminToken,
          finalScope,
          finalMilestoneIds,
          disputedAmount,
        ],
      );

      // 9. Add a system message to the chat so both parties can see the dispute was opened
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

      // 10. Build the admin moderator link
      const adminLink = `${process.env.FRONTEND_URL}/admin/dispute/${adminToken}`;

      // 11. Email the admin
      const adminEmailMsg = {
        to: process.env.ADMIN_EMAIL,
        from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
        subject: `[Admin] New Dispute Opened  - Invoice ${invoicenumber} | Fonlok`,
        html: emailWrap(
          `<h2 style="color:#0F1F3D;margin:0 0 12px;">New Dispute Opened &mdash; Invoice ${invoicenumber}</h2>
          <p style="color:#475569;">A dispute has been opened and requires your review.</p>
          ${emailTable([
            ["Invoice Number", invoicenumber],
            ["Invoice Name", invoice.invoicename],
            [
              "Disputed Amount",
              `${disputedAmount.toLocaleString()} ${invoice.currency}`,
              "font-weight:700;font-size:15px;",
            ],
            [
              "Dispute Scope",
              isMilestoneInvoice
                ? `${finalScope} (${finalMilestoneIds.length} milestone(s))`
                : "Full invoice",
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

      // 12. Fetch buyer email for party notifications
      const buyerEmailResult = await db.query(
        "SELECT email FROM guests WHERE invoicenumber = $1 ORDER BY id DESC LIMIT 1",
        [invoicenumber],
      );
      const buyerEmail = buyerEmailResult.rows[0]?.email || null;
      const sellerEmail = invoice.clientemail;
      const chatLink = `${process.env.FRONTEND_URL}/chat/${invoicenumber}`;
      const invoicePageLink = `${process.env.FRONTEND_URL}/invoice/${invoicenumber}`;

      // 13. Email the seller
      if (sellerEmail) {
        const isSellerOpener = opened_by === "seller";
        const sellerLanguage = await getUserEmailLanguageByEmail(sellerEmail);
        const sellerDispute = buildEmailCopy(sellerLanguage, "disputeOpened");
        const sellerDisputeMsg = {
          to: sellerEmail,
          from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
          subject: sellerDispute.sellerSubject(invoicenumber),
          html: emailWrap(
            `<h2 style="color:#0F1F3D;margin:0 0 12px;">${sellerDispute.sellerTitle}</h2>
            <p style="color:#475569;">${
              isSellerOpener
                ? sellerLanguage === "fr"
                  ? "Nous avons reçu votre demande de litige. Notre équipe d'administration examinera tous les messages et prendra une décision équitable dans <strong>24 à 48 heures</strong>."
                  : "We have received your dispute request. Our admin team will review all messages and make a fair decision within 24-48 hours."
                : sellerLanguage === "fr"
                  ? "Un acheteur a ouvert un litige sur l'une de vos factures. Notre équipe d'administration a été notifiée et examinera le dossier dans <strong>24 à 48 heures</strong>."
                  : "A buyer has filed a dispute on one of your invoices. Our admin team has been notified and will review the case within 24-48 hours."
            }</p>
            ${emailTable([
              ["Invoice Number", invoicenumber],
              ["Invoice Name", invoice.invoicename],
              [
                "Amount",
                `${invoice.amount} ${invoice.currency}`,
                "font-weight:700;font-size:15px;",
              ],
              [
                sellerLanguage === "fr" ? "Ouvert par" : "Opened By",
                sellerLanguage === "fr" ? "Acheteur" : "Buyer",
              ],
              [sellerLanguage === "fr" ? "Raison" : "Reason", reason],
            ])}
            <p style="color:#475569;">${sellerLanguage === "fr" ? "Vous pouvez consulter la conversation complète et suivre la résolution du litige dans le fil de discussion." : "You can view the full conversation and track the dispute resolution in the chat thread."}</p>
            ${emailButton(chatLink, sellerDispute.button)}`,
            {
              subtitle:
                sellerLanguage === "fr"
                  ? "Notification de litige"
                  : "Dispute Notification",
              footerNote:
                sellerLanguage === "fr"
                  ? "Veuillez ne pas essayer de faire pression sur l'autre partie. Tous les litiges sont examinés et résolus équitablement par l'administration de Fonlok."
                  : "Please do not attempt to pressure the other party. All disputes are reviewed and resolved fairly by Fonlok admin.",
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

      // 14. Email the buyer
      if (buyerEmail) {
        const buyerLanguage = await getUserEmailLanguageByEmail(buyerEmail);
        const buyerDispute = buildEmailCopy(buyerLanguage, "disputeOpened");
        const isBuyerOpener = opened_by === "buyer";
        const buyerDisputeMsg = {
          to: buyerEmail,
          from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
          subject: buyerDispute.buyerSubject(invoicenumber),
          html: emailWrap(
            `<h2 style="color:#0F1F3D;margin:0 0 12px;">${buyerDispute.buyerTitle}</h2>
            <p style="color:#475569;">${buyerDispute.buyerBody(invoicenumber)}</p>
            ${emailTable([
              ["Invoice Number", invoicenumber],
              ["Invoice Name", invoice.invoicename],
              [
                "Amount",
                `${invoice.amount} ${invoice.currency}`,
                "font-weight:700;font-size:15px;",
              ],
              [
                buyerLanguage === "fr" ? "Ouvert par" : "Opened By",
                isBuyerOpener
                  ? buyerLanguage === "fr"
                    ? "Vous (Acheteur)"
                    : "You (buyer)"
                  : buyerLanguage === "fr"
                    ? "Vendeur"
                    : "Seller",
              ],
              [buyerLanguage === "fr" ? "Raison" : "Reason", reason],
            ])}
            <p style="color:#475569;">${buyerLanguage === "fr" ? "Vos fonds sont en toute sécurité en séquestre et ne seront pas libérés tant que le litige ne sera pas résolu." : "Your funds are safely held in escrow and will not be released until the dispute is resolved."}</p>
            ${emailButton(invoicePageLink, buyerDispute.button)}`,
            {
              subtitle:
                buyerLanguage === "fr"
                  ? "Notification de litige"
                  : "Dispute Notification",
              footerNote:
                buyerLanguage === "fr"
                  ? "Veuillez ne pas essayer de faire pression sur l'autre partie. Tous les litiges sont examinés et résolus équitablement par l'administration de Fonlok."
                  : "Please do not attempt to pressure the other party. All disputes are reviewed and resolved fairly by Fonlok admin.",
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

    // 6. Fetch milestones if applicable
    let milestones = [];
    let disputedMilestones = [];
    let effectiveEscrowAmount = Number(invoice.amount);

    if (invoice.payment_type === "installment") {
      const msRes = await db.query(
        "SELECT * FROM invoice_milestones WHERE invoice_id = $1 ORDER BY milestone_number ASC",
        [invoice.id],
      );
      milestones = msRes.rows;
      const disputedIds = dispute.disputed_milestone_ids || [];
      if (disputedIds.length > 0) {
        disputedMilestones = milestones.filter((m) =>
          disputedIds.includes(m.id),
        );
      } else {
        disputedMilestones = milestones.filter((m) => m.status !== "released");
      }
      // effectiveEscrowAmount = only the unreleased disputed milestones
      effectiveEscrowAmount = disputedMilestones
        .filter((m) => m.status !== "released")
        .reduce((sum, m) => sum + Number(m.amount), 0);
    }

    return res.status(200).json({
      dispute,
      invoice,
      buyer,
      seller,
      messages,
      milestones,
      disputedMilestones,
      effectiveEscrowAmount,
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
// POST /dispute/admin/:admin_token/resolve
// Body: { decision: "seller" | "buyer", milestone_ids?: number[] }
//
// decision "seller" = release funds to the seller (3% fee deducted)
// decision "buyer"  = refund the buyer (3% fee borne by buyer)
//
// milestone_ids (optional): if provided, resolves ONLY those specific
//   milestones. Omit to resolve all eligible disputed milestones at once.
//
// ── SECURITY MODEL ──────────────────────────────────────────
// At resolution time we RE-QUERY the live milestone statuses.
// We NEVER use the amount stored in the dispute record (stale).
// Milestones already released are excluded, preventing double-payout.
// ─────────────────────────────────────────────────────────────
// ------------------------------------------------------------
router.post(
  "/admin/:admin_token/resolve",
  [
    body("decision")
      .trim()
      .isIn(["seller", "buyer"])
      .withMessage("Decision must be 'seller' or 'buyer'."),
    body("milestone_ids")
      .optional()
      .isArray({ min: 1 })
      .withMessage("milestone_ids must be a non-empty array when provided."),
    body("milestone_ids.*")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Each milestone_id must be a positive integer."),
  ],
  validate,
  async (req, res) => {
    const { admin_token } = req.params;
    const { decision, milestone_ids: requestedMilestoneIds } = req.body;

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

      if (
        dispute.status !== "open" &&
        !dispute.status.startsWith("partially_resolved")
      ) {
        return res
          .status(400)
          .json({ message: "This dispute has already been fully resolved." });
      }

      // 2. Get the invoice
      const invoiceResult = await db.query(
        "SELECT * FROM invoices WHERE invoicenumber = $1",
        [dispute.invoicenumber],
      );
      const invoice = invoiceResult.rows[0];

      // 3. Get the chat for post-resolution system messages
      const chatResult = await db.query(
        "SELECT * FROM chats WHERE invoicenumber = $1",
        [dispute.invoicenumber],
      );

      // ── SECURITY CRITICAL: Compute effective payout amount live ─────────
      // For milestone invoices we ALWAYS re-query current statuses.
      // We NEVER use disputed_amount from the disputes table (stale).
      // ───────────────────────────────────────────────────────────────────
      const isMilestoneInvoiceR = invoice.payment_type === "installment";
      let effectiveAmount = Number(invoice.amount);
      let eligibleMilestones = null;

      if (isMilestoneInvoiceR) {
        const currentMsResult = await db.query(
          "SELECT * FROM invoice_milestones WHERE invoice_id = $1 ORDER BY milestone_number ASC",
          [invoice.id],
        );
        const allCurrentMilestones = currentMsResult.rows;

        let targetIds = [];
        if (
          requestedMilestoneIds &&
          Array.isArray(requestedMilestoneIds) &&
          requestedMilestoneIds.length > 0
        ) {
          targetIds = requestedMilestoneIds.map((id) => parseInt(id, 10));
          const disputedIds = dispute.disputed_milestone_ids || [];
          if (disputedIds.length > 0) {
            const outOfScope = targetIds.filter(
              (id) => !disputedIds.includes(id),
            );
            if (outOfScope.length > 0) {
              return res.status(400).json({
                message: `Milestone ID(s) [${outOfScope.join(", ")}] are not within the scope of this dispute.`,
              });
            }
          }
        } else {
          const disputedIds = dispute.disputed_milestone_ids || [];
          targetIds =
            disputedIds.length > 0
              ? disputedIds
              : allCurrentMilestones.map((m) => m.id);
        }

        const alreadyReleased = allCurrentMilestones.filter(
          (m) => targetIds.includes(m.id) && m.status === "released",
        );
        eligibleMilestones = allCurrentMilestones.filter(
          (m) => targetIds.includes(m.id) && m.status !== "released",
        );

        if (alreadyReleased.length > 0) {
          console.warn(
            `⚠️  Dispute ${dispute.invoicenumber}: ${alreadyReleased.length} milestone(s) already ` +
              `released (IDs: ${alreadyReleased.map((m) => m.id).join(", ")})  -  excluded from payout.`,
          );
        }

        if (eligibleMilestones.length === 0) {
          return res.status(400).json({
            message:
              "All targeted milestones have already been released. No escrowed funds remain for this dispute scope.",
            already_released_ids: alreadyReleased.map((m) => m.id),
          });
        }

        effectiveAmount = eligibleMilestones.reduce(
          (sum, m) => sum + Number(m.amount),
          0,
        );
        console.log(
          `Dispute resolve ${invoice.invoicenumber}: decision=${decision}, ` +
            `eligible=[${eligibleMilestones.map((m) => m.id)}], effectiveAmount=${effectiveAmount} XAF`,
        );
      } else {
        // Non-milestone: block if funds were already released via a prior payout
        const existingPayout = await db.query(
          "SELECT id FROM payouts WHERE invoice_id = $1 AND status = 'paid'",
          [invoice.id],
        );
        if (existingPayout.rows.length > 0) {
          return res.status(400).json({
            message:
              "Funds for this invoice were already released to the seller via a prior payout. " +
              "Releasing again would cause a double-payment. Only 'Refund Buyer' is valid.",
          });
        }
      }

      // ── Fee calculation ────────────────────────────────────────────────
      const DISPUTE_TOTAL_FEE_RATE = 0.02;
      const DISPUTE_REFERRAL_FEE_RATE = 0.005;

      const referrerCheckD = await db.query(
        "SELECT referred_by FROM users WHERE id = $1",
        [invoice.userid],
      );
      const referrerIdD = referrerCheckD.rows[0]?.referred_by ?? null;
      const hasReferralD = referrerIdD !== null;

      const totalFeeD = Math.floor(effectiveAmount * DISPUTE_TOTAL_FEE_RATE);
      const referralEarningD = hasReferralD
        ? Math.floor(effectiveAmount * DISPUTE_REFERRAL_FEE_RATE)
        : 0;
      const fonlokNetD = totalFeeD - referralEarningD;

      // Display-only fee: show the combined 3% (Fonlok 2% + Campay ~1%) in
      // emails, chat messages, and webhooks. Payout variables are unchanged.
      const displayFee    = Math.round(effectiveAmount * 0.03);
      const displayAmount = effectiveAmount - displayFee;

      // Helper: compute final dispute status after this resolution
      const computeDisputeStatus = async (baseStatus) => {
        if (!isMilestoneInvoiceR) return baseStatus;
        const disputedIds = dispute.disputed_milestone_ids || [];
        if (disputedIds.length === 0) return baseStatus;
        const remaining = await db.query(
          `SELECT id FROM invoice_milestones WHERE id = ANY($1::int[]) AND status != 'released'`,
          [disputedIds],
        );
        return remaining.rows.length > 0
          ? `partially_${baseStatus}`
          : baseStatus;
      };

      if (decision === "seller") {
        // ── DECISION: Release funds to the seller ──────────────────────────
        const sellerShare = effectiveAmount - totalFeeD;
        // For API invoices use the seller credentials sent by the platform —
        // never the Fonlok users table (which holds the platform account, not the seller).
        let seller;
        if (invoice.created_via_api) {
          seller = {
            phone: invoice.seller_phone,
            email: invoice.seller_email,
            name:  invoice.seller_name,
          };
        } else {
          const sellerResult = await db.query(
            "SELECT * FROM users WHERE id = $1",
            [invoice.userid],
          );
          seller = sellerResult.rows[0];
        }

        console.log(
          `Dispute payout (seller) ${invoice.invoicenumber}: gross=${effectiveAmount}, ` +
            `fee=${totalFeeD}, fonlokNet=${fonlokNetD}, referralEarning=${referralEarningD}, sellerReceives=${sellerShare}`,
        );

        const campayAuthS = await axios.post(
          `${process.env.CAMPAY_BASE_URL}token/`,
          {
            username: process.env.CAMPAY_USERNAME,
            password: process.env.CAMPAY_PASSWORD,
          },
        );
        await axios.post(
          `${process.env.CAMPAY_BASE_URL}withdraw/`,
          {
            amount: sellerShare.toString(),
            currency: "XAF",
            to: seller.phone,
            description: `Dispute resolved (seller)  -  invoice ${invoice.invoicenumber}`,
            external_reference: `dispute-seller-${invoice.invoicenumber}-${Date.now()}`,
          },
          { headers: { Authorization: `Token ${campayAuthS.data.token}` } },
        );

        if (isMilestoneInvoiceR && eligibleMilestones.length > 0) {
          await db.query(
            `UPDATE invoice_milestones
                SET status = 'released', released_at = NOW(), release_token = NULL, dispute_resolution = 'seller'
              WHERE id = ANY($1::int[])`,
            [eligibleMilestones.map((m) => m.id)],
          );
        }

        await db.query(
          "INSERT INTO payouts (userid, amount, method, status, invoice_id, invoice_number) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            invoice.userid,
            sellerShare,
            "Mobile Money",
            "paid",
            invoice.id,
            invoice.invoicenumber,
          ],
        );

        if (hasReferralD && referralEarningD > 0) {
          try {
            const ins = await db.query(
              `INSERT INTO referral_earnings
                 (referrer_userid, referred_userid, invoice_number, invoice_amount, earned_amount)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (invoice_number) DO NOTHING
               RETURNING id`,
              [
                referrerIdD,
                invoice.userid,
                `${invoice.invoicenumber}-dispute-s`,
                effectiveAmount,
                referralEarningD,
              ],
            );
            if (ins.rows.length > 0) {
              await db.query(
                "UPDATE users SET referral_balance = referral_balance + $1 WHERE id = $2",
                [referralEarningD, referrerIdD],
              );
            }
          } catch (e) {
            console.error("⚠️ Dispute referral credit error:", e.message);
          }
        }

        if (isMilestoneInvoiceR) {
          const totalRem = await db.query(
            "SELECT COUNT(*) AS cnt FROM invoice_milestones WHERE invoice_id = $1 AND status != 'released'",
            [invoice.id],
          );
          if (parseInt(totalRem.rows[0].cnt) === 0) {
            await db.query(
              "UPDATE invoices SET status = 'completed' WHERE id = $1",
              [invoice.id],
            );
          }
        } else {
          await db.query(
            "UPDATE invoices SET status = 'completed' WHERE id = $1",
            [invoice.id],
          );
        }

        const finalStatus = await computeDisputeStatus("resolved_seller");
        await db.query(
          "UPDATE disputes SET status = $1 WHERE admin_token = $2",
          [finalStatus, admin_token],
        );

        if (chatResult.rows.length > 0) {
          const isFinal = !finalStatus.startsWith("partially");
          await db.query(
            "INSERT INTO messages (chat_id, sender_type, sender_email, message) VALUES ($1,$2,$3,$4)",
            [
              chatResult.rows[0].id,
              "system",
              "system",
              isFinal
                ? `✅ Dispute resolved by admin. ${displayAmount.toLocaleString()} XAF released to the seller.`
                : `⚠️ Admin resolved ${eligibleMilestones.length} milestone(s). ${displayAmount.toLocaleString()} XAF released to the seller. Dispute remains open for remaining milestones.`,
            ],
          );
        }

        try {
          await sgMail.send({
            to: seller.email,
            from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
            subject: `Dispute Resolved: Funds Released to You  -  Invoice ${invoice.invoicenumber} | Fonlok`,
            html: emailWrap(
              `<h2 style="color:#0F1F3D;margin:0 0 12px;">Dispute Resolved  -  Funds Released to You</h2>
              <p style="color:#475569;">Hello ${seller.name}, the admin reviewed the dispute for invoice <strong>${invoice.invoicenumber}</strong> and released funds to you.</p>
              ${emailTable([
                ["Invoice", invoice.invoicenumber],
                ["Effective Amount", `${effectiveAmount.toLocaleString()} XAF`],
                [
                  "Fonlok Fee (3%)",
                  `-${displayFee.toLocaleString()} XAF`,
                  "color:#dc2626;",
                ],
                [
                  "Amount Sent",
                  `${displayAmount.toLocaleString()} XAF`,
                  "font-weight:700;color:#16a34a;font-size:15px;",
                ],
                ["Sent To", seller.phone],
              ])}`,
              {
                footerNote:
                  "Fonlok Escrow  -  dispute resolved in your favour.",
              },
            ),
          });
        } catch (e) {
          console.error("Seller dispute email error:", e.message);
        }

        try {
          // For API invoices use the buyer email from the invoice; for regular invoices use guests table.
          const buyerNotifEmail = invoice.created_via_api
            ? (invoice.clientemail || null)
            : (await db.query("SELECT email FROM guests WHERE invoicenumber = $1", [invoice.invoicenumber])).rows[0]?.email;
          if (buyerNotifEmail) {
            await sgMail.send({
              to: buyerNotifEmail,
              from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
              subject: `Dispute Update  -  Invoice ${invoice.invoicenumber} | Fonlok`,
              html: emailWrap(
                `<h2 style="color:#0F1F3D;margin:0 0 12px;">Dispute Resolved</h2>
                <p style="color:#475569;">The admin reviewed the dispute for invoice <strong>${invoice.invoicenumber}</strong> and decided to release the funds to the seller.</p>
                <p style="color:#475569;">If you believe this was unfair, contact <a href="mailto:support@fonlok.com" style="color:#F59E0B;">support@fonlok.com</a>.</p>`,
                { footerNote: "Fonlok Escrow dispute resolution." },
              ),
            });
          }
        } catch (e) {
          console.error("Buyer dispute email error:", e.message);
        }

        // Fire webhook so API platforms (e.g. Njimbong) are notified of the outcome
        if (invoice.created_via_api) {
          deliverWebhookEvent(invoice.userid, "payment.dispute_resolved", {
            object: "event",
            type: "payment.dispute_resolved",
            invoice_id: invoice.invoicenumber,
            decision: "seller",
            amount: effectiveAmount,
            amount_disbursed: displayAmount,
            currency: invoice.currency || "XAF",
            status: finalStatus,
            timestamp: new Date().toISOString(),
          }).catch(() => {});
        }

        return res.status(200).json({
          message: `Dispute resolved. ${displayAmount.toLocaleString()} XAF released to the seller.`,
          sellerReceives: sellerShare,
          effectiveAmount,
          status: finalStatus,
        });
      } else if (decision === "buyer") {
        // ── DECISION: Refund the buyer ────────────────────────────────────
        const refundAmount = effectiveAmount - totalFeeD;

        // For API invoices use the buyer credentials from the invoice —
        // never the Fonlok guests table (which holds the platform account, not the buyer).
        let buyerMoMo, buyerEmail;
        if (invoice.created_via_api) {
          buyerMoMo  = invoice.buyer_phone || null;
          buyerEmail = invoice.clientemail || null;
        } else {
          const guestResult = await db.query(
            "SELECT * FROM guests WHERE invoicenumber = $1",
            [invoice.invoicenumber],
          );
          const guest = guestResult.rows[0] ?? null;
          buyerMoMo  = guest?.momo_number || null;
          buyerEmail = guest?.email       || null;
        }

        if (!buyerMoMo) {
          return res.status(400).json({
            message:
              "Cannot process refund: no buyer MoMo number found. Please process manually.",
          });
        }

        console.log(
          `Dispute refund (buyer) ${invoice.invoicenumber}: gross=${effectiveAmount}, fee=${totalFeeD}, refundAmount=${refundAmount}`,
        );

        const campayAuthB = await axios.post(
          `${process.env.CAMPAY_BASE_URL}token/`,
          {
            username: process.env.CAMPAY_USERNAME,
            password: process.env.CAMPAY_PASSWORD,
          },
        );
        await axios.post(
          `${process.env.CAMPAY_BASE_URL}withdraw/`,
          {
            amount: refundAmount.toString(),
            currency: "XAF",
            to: buyerMoMo,
            description: `Dispute refund  -  invoice ${invoice.invoicenumber}`,
            external_reference: `dispute-refund-${invoice.invoicenumber}-${Date.now()}`,
          },
          { headers: { Authorization: `Token ${campayAuthB.data.token}` } },
        );

        if (isMilestoneInvoiceR && eligibleMilestones.length > 0) {
          await db.query(
            `UPDATE invoice_milestones
                SET status = 'released', released_at = NOW(), release_token = NULL, dispute_resolution = 'buyer'
              WHERE id = ANY($1::int[])`,
            [eligibleMilestones.map((m) => m.id)],
          );
        }

        await db.query(
          "INSERT INTO payouts (userid, amount, method, status, invoice_id, invoice_number) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            invoice.userid,
            refundAmount,
            "Refund to Buyer",
            "refunded",
            invoice.id,
            invoice.invoicenumber,
          ],
        );

        if (isMilestoneInvoiceR) {
          const totalRemB = await db.query(
            "SELECT COUNT(*) AS cnt FROM invoice_milestones WHERE invoice_id = $1 AND status != 'released'",
            [invoice.id],
          );
          if (parseInt(totalRemB.rows[0].cnt) === 0) {
            await db.query(
              "UPDATE invoices SET status = 'refunded' WHERE id = $1",
              [invoice.id],
            );
          }
        } else {
          await db.query(
            "UPDATE invoices SET status = 'refunded' WHERE id = $1",
            [invoice.id],
          );
        }

        const finalStatusB = await computeDisputeStatus("resolved_buyer");
        await db.query(
          "UPDATE disputes SET status = $1 WHERE admin_token = $2",
          [finalStatusB, admin_token],
        );

        if (chatResult.rows.length > 0) {
          const isFinalB = !finalStatusB.startsWith("partially");
          await db.query(
            "INSERT INTO messages (chat_id, sender_type, sender_email, message) VALUES ($1,$2,$3,$4)",
            [
              chatResult.rows[0].id,
              "system",
              "system",
              isFinalB
                ? `✅ Dispute resolved by admin. Refund of ${displayAmount.toLocaleString()} XAF sent to the buyer.`
                : `⚠️ Admin refunded ${eligibleMilestones.length} milestone(s). ${displayAmount.toLocaleString()} XAF sent to buyer. Dispute remains open for remaining milestones.`,
            ],
          );
        }

        try {
          if (buyerEmail) {
            await sgMail.send({
              to: buyerEmail,
              from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
              subject: `Refund Processed  -  Invoice ${invoice.invoicenumber} | Fonlok`,
              html: emailWrap(
                `<h2 style="color:#0F1F3D;margin:0 0 12px;">Refund Processed  -  Funds Sent to You</h2>
                <p style="color:#475569;">The admin reviewed the dispute for invoice <strong>${invoice.invoicenumber}</strong> and processed your refund.</p>
                ${emailTable([
                  ["Invoice", invoice.invoicenumber],
                  [
                    "Gross Disputed Amount",
                    `${effectiveAmount.toLocaleString()} XAF`,
                  ],
                  [
                    "Fonlok Fee (3%)",
                    `-${displayFee.toLocaleString()} XAF`,
                    "color:#dc2626;",
                  ],
                  [
                    "Refund Sent to You",
                    `${displayAmount.toLocaleString()} XAF`,
                    "font-weight:700;color:#16a34a;font-size:15px;",
                  ],
                  ["Sent To", buyerMoMo],
                ])}`,
                { footerNote: "Fonlok Escrow dispute refund confirmation." },
              ),
            });
          }
        } catch (e) {
          console.error("Buyer refund email error:", e.message);
        }

        try {
          // For API invoices use the seller credentials from the invoice; for regular invoices use users table.
          let sellerNotifEmail, sellerNotifName;
          if (invoice.created_via_api) {
            sellerNotifEmail = invoice.seller_email || null;
            sellerNotifName  = invoice.seller_name  || "Seller";
          } else {
            const sR = await db.query("SELECT email, name FROM users WHERE id = $1", [invoice.userid]);
            sellerNotifEmail = sR.rows[0]?.email || null;
            sellerNotifName  = sR.rows[0]?.name  || "Seller";
          }
          if (sellerNotifEmail) {
            await sgMail.send({
              to: sellerNotifEmail,
              from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
              subject: `Dispute Resolved: Refund Issued to Buyer  -  Invoice ${invoice.invoicenumber} | Fonlok`,
              html: emailWrap(
                `<h2 style="color:#0F1F3D;margin:0 0 12px;">Dispute Resolved  -  Refund Issued to Buyer</h2>
                <p style="color:#475569;">Hello ${sellerNotifName}, the admin reviewed the dispute for invoice <strong>${invoice.invoicenumber}</strong> and issued a refund to the buyer.</p>
                <p style="color:#475569;">If you believe this was unfair, contact <a href="mailto:support@fonlok.com" style="color:#F59E0B;">support@fonlok.com</a>.</p>`,
                {
                  footerNote: "Fonlok Escrow dispute resolution notification.",
                },
              ),
            });
          }
        } catch (e) {
          console.error("Seller refund email error:", e.message);
        }

        // Fire webhook so API platforms (e.g. Njimbong) are notified of the outcome
        if (invoice.created_via_api) {
          deliverWebhookEvent(invoice.userid, "payment.dispute_resolved", {
            object: "event",
            type: "payment.dispute_resolved",
            invoice_id: invoice.invoicenumber,
            decision: "buyer",
            amount: effectiveAmount,
            amount_disbursed: displayAmount,
            currency: invoice.currency || "XAF",
            status: finalStatusB,
            timestamp: new Date().toISOString(),
          }).catch(() => {});
        }

        return res.status(200).json({
          message: `Dispute resolved. Refund of ${displayAmount.toLocaleString()} XAF sent to the buyer.`,
          refundAmount,
          effectiveAmount,
          status: finalStatusB,
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
