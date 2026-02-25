import express from "express";
const router = express.Router();
import db from "../controllers/db.js";
import dotenv from "dotenv";
import crypto from "crypto";
import authMiddleware from "../middleware/authMiddleware.js";
import sgMail from "@sendgrid/mail";
import { body } from "express-validator";
import { validate } from "../middleware/validate.js";
import {
  emailWrap,
  emailTable,
  emailButton,
  emailButtonDanger,
} from "../utils/emailTemplate.js";
import { generateReceiptPdf } from "../utils/generateReceipt.js";
dotenv.config();

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ── Ensure viewed_at column exists ──────────────────────────────────────────────
db.query(
  "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ",
).catch((e) => console.error("⚠️  viewed_at migration error:", e.message));

// ── Ensure paid_at and delivered_at columns exist ────────────────────────────
db.query(
  "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ",
).catch((e) => console.error("⚠️  paid_at migration error:", e.message));

db.query(
  "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ",
).catch((e) => console.error("⚠️  delivered_at migration error:", e.message));

// ── Ensure guests.registered_userid column exists ─────────────────────────────
db.query(
  "ALTER TABLE guests ADD COLUMN IF NOT EXISTS registered_userid INTEGER REFERENCES users(id)",
).catch((e) =>
  console.error("⚠️  registered_userid migration error:", e.message),
);

// ── Migrate guests unique constraint: (email) → (email, invoicenumber) ────────
// This allows a buyer to have multiple purchases &mdash; one row per invoice paid.
db.query(
  `
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'guests_email_key' AND conrelid = 'guests'::regclass
    ) THEN
      ALTER TABLE guests DROP CONSTRAINT guests_email_key;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'guests_email_invoicenumber_key' AND conrelid = 'guests'::regclass
    ) THEN
      ALTER TABLE guests ADD CONSTRAINT guests_email_invoicenumber_key UNIQUE (email, invoicenumber);
    END IF;
  END $$;
`,
).catch((e) =>
  console.error("⚠️  guests constraint migration error:", e.message),
);

// ── Normalise legacy currency values to XAF ──────────────────────────────────
// Old invoices may have been stored with currency='USD' &mdash; fix them to 'XAF'.
db.query(
  `UPDATE invoices SET currency = 'XAF' WHERE currency IS NULL OR currency = 'USD'`,
).catch((e) => console.error("⚠️  currency normalisation error:", e.message));

router.post(
  "/create",
  authMiddleware,
  [
    body("invoicename")
      .trim()
      .notEmpty()
      .withMessage("Invoice name is required.")
      .isLength({ max: 200 })
      .withMessage("Invoice name must be 200 characters or fewer.")
      .escape(),

    body("email")
      .trim()
      .isEmail()
      .withMessage("A valid client email address is required.")
      .normalizeEmail(),

    body("currency")
      .trim()
      .notEmpty()
      .withMessage("Currency is required.")
      .isIn(["XAF"])
      .withMessage("Currency must be XAF."),

    body("amount")
      .notEmpty()
      .withMessage("Amount is required.")
      .isFloat({ min: 0 })
      .withMessage("Amount must be a positive number."),

    body("description")
      .optional({ checkFalsy: true })
      .trim()
      .isLength({ max: 2000 })
      .withMessage("Description must be 2000 characters or fewer.")
      .escape(),

    body("expires_at")
      .optional({ checkFalsy: true })
      .isISO8601()
      .withMessage("Expiry date must be a valid date (YYYY-MM-DD)."),

    body("payment_type")
      .optional({ checkFalsy: true })
      .isIn(["full", "installment"])
      .withMessage("Payment type must be 'full' or 'installment'."),

    // Validate milestone labels and amounts if present
    body("milestones.*.label")
      .optional()
      .trim()
      .notEmpty()
      .withMessage("Each milestone must have a label.")
      .isLength({ max: 200 })
      .withMessage("Milestone label must be 200 characters or fewer.")
      .escape(),

    body("milestones.*.amount")
      .optional()
      .isFloat({ min: 1 })
      .withMessage("Each milestone must have a positive amount."),
  ],
  validate,
  async (req, res) => {
    const {
      invoicename,
      email,
      currency,
      amount,
      description,
      expires_at,
      // Installment fields &mdash; optional
      payment_type, // "full" | "installment"
      milestones, // array of { label, amount, deadline? } &mdash; only for installment
    } = req.body;

    const isInstallment = payment_type === "installment";

    // --- Validate milestones if installment ---
    if (isInstallment) {
      if (!Array.isArray(milestones) || milestones.length < 2) {
        return res.status(400).json({
          message: "Installment invoices require at least 2 milestones.",
        });
      }
      const totalMilestoneAmount = milestones.reduce(
        (sum, m) => sum + Number(m.amount || 0),
        0,
      );
      if (totalMilestoneAmount !== Number(amount)) {
        return res.status(400).json({
          message: `Milestone amounts must add up to the full invoice total (${amount} XAF). Current total: ${totalMilestoneAmount} XAF.`,
        });
      }
      for (const m of milestones) {
        if (!m.label || !m.label.trim()) {
          return res
            .status(400)
            .json({ message: "Each milestone must have a label." });
        }
        if (!m.amount || Number(m.amount) <= 0) {
          return res
            .status(400)
            .json({ message: "Each milestone must have a positive amount." });
        }
      }
    }

    try {
      const response = await db.query("SELECT * FROM users WHERE id = $1", [
        req.user.id,
      ]);
      if (response.rows.length === 0) {
        return res
          .status(404)
          .json({ message: "No account found. Please sign in again." });
      }
      const user = response.rows[0];

      // Verify the submitted email matches the authenticated user's email
      if (email.toLowerCase() !== user.email.toLowerCase()) {
        return res.status(403).json({
          message:
            "The email you entered does not match your Fonlok account email. You can only create invoices from your own account.",
        });
      }
      const userId = user.id;
      const rounds = crypto.randomUUID().slice(0, 12);
      const invoiceNumber = `${userId}-${rounds}`;
      const userid = user.id;
      const invoiceLink = `${process.env.FRONTEND_URL}/invoice/${invoiceNumber}`;

      const invoiceResult = await db.query(
        "INSERT INTO invoices (invoicename, clientemail, currency, amount, invoiceNumber, userid, invoiceLink, description, expires_at, payment_type) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *",
        [
          invoicename,
          email,
          currency,
          amount,
          invoiceNumber,
          userid,
          invoiceLink,
          description,
          expires_at || null,
          isInstallment ? "installment" : "full",
        ],
      );

      const newInvoice = invoiceResult.rows[0];

      // --- Save milestones if installment ---
      if (isInstallment) {
        for (let i = 0; i < milestones.length; i++) {
          const m = milestones[i];
          await db.query(
            "INSERT INTO invoice_milestones (invoice_id, invoice_number, milestone_number, label, amount, deadline) VALUES ($1, $2, $3, $4, $5, $6)",
            [
              newInvoice.id,
              invoiceNumber,
              i + 1,
              m.label.trim(),
              Number(m.amount),
              m.deadline || null,
            ],
          );
        }
        console.log(
          `✅ ${milestones.length} milestones saved for invoice ${invoiceNumber}`,
        );
      }

      return res.status(201).json({ "Invoice Link": invoiceLink });
    } catch (error) {
      console.log(error.message);
      return res
        .status(500)
        .json({ message: "Failed to create invoice. Please try again." });
    }
  },
);

router.get("/all/:id", async (req, res) => {
  const userId = req.params.id;
  try {
    const result = await db.query(
      "SELECT * FROM invoices WHERE userid = $1 ORDER BY createdat DESC",
      [userId],
    );
    if (result.rows.length === 0) {
      console.log(`No invoices found for user: ${userId}`);
    }
    const invoices = result.rows;
    return res.status(200).json({ invoices: invoices, userId: userId });
  } catch (error) {
    console.log(error.message);
    return res
      .status(500)
      .json({ message: "Failed to retrieve invoices. Please try again." });
  }
});

router.get("/reload", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await db.query("SELECT username FROM users WHERE id = $1", [
      userId,
    ]);
    const username = result.rows[0]?.username || null;
    return res.status(200).json({ userId, username });
  } catch {
    return res.status(200).json({ userId, username: null });
  }
});

router.get("/filter/:id", async (req, res) => {
  const user_id = req.params.id;
  const { amount, currency } = req.query;
  try {
    const result = await db.query(
      "SELECT * FROM invoices WHERE userid = $1 AND (amount = $2 OR currency = $3) ORDER BY createdat DESC",
      [user_id, amount, currency],
    );
    if (result.rows.length === 0) {
      console.log("No invoices found matching this filter.");
    }
    const invoice = result.rows;
    return res.status(200).json({ invoice: invoice });
  } catch (error) {
    console.log(error.message);
    return res
      .status(500)
      .json({ message: "Failed to filter invoices. Please try again." });
  }
});

router.delete("/delete/:id", authMiddleware, async (req, res) => {
  const invoiceId = req.params.id;

  try {
    // 1. Check the invoice exists
    const invoiceCheck = await db.query(
      "SELECT * FROM invoices WHERE id = $1",
      [invoiceId],
    );
    if (invoiceCheck.rows.length === 0) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const invoice = invoiceCheck.rows[0];

    // 2. Ensure the authenticated user owns this invoice
    if (invoice.userid !== req.user.id) {
      return res.status(403).json({
        message: "You are not authorized to delete this invoice.",
      });
    }

    // 3. Block deletion if the invoice has an active or completed payment lifecycle
    if (["paid", "delivered", "completed"].includes(invoice.status)) {
      const statusMessages = {
        paid: "This invoice cannot be deleted because the buyer has already paid. Funds are held in escrow.",
        delivered:
          "This invoice cannot be deleted because delivery has been marked and is awaiting buyer confirmation.",
        completed:
          "This invoice cannot be deleted because the payout has already been processed.",
      };
      return res.status(403).json({
        message: statusMessages[invoice.status],
      });
    }

    // 4. Block deletion if a payout has already been made for THIS specific invoice
    const payoutCheck = await db.query(
      "SELECT * FROM payouts WHERE invoice_id = $1 AND status = 'paid'",
      [invoiceId],
    );
    if (payoutCheck.rows.length > 0) {
      return res.status(403).json({
        message:
          "This invoice cannot be deleted because a payout has already been made.",
      });
    }

    // 5. Block deletion if a payment is currently pending
    const pendingPaymentCheck = await db.query(
      "SELECT * FROM payments WHERE invoiceid = $1 AND status = 'pending'",
      [invoiceId],
    );
    if (pendingPaymentCheck.rows.length > 0) {
      return res.status(403).json({
        message:
          "This invoice cannot be deleted because a payment is currently being processed.",
      });
    }

    // 6. All checks passed &mdash; safe to delete
    const result = await db.query(
      "DELETE FROM invoices WHERE id = $1 RETURNING *",
      [invoiceId],
    );
    const invoices = result.rows;
    res.status(200).json({ invoices: invoices });
  } catch (error) {
    console.log(error.message);
    res
      .status(500)
      .json({ message: "An error occurred while deleting the invoice." });
  }
});

router.patch("/edit/:id", async (req, res) => {
  const invoice_number = req.params.id;
  const { invoicename, currency, amount } = req.body;
  try {
    const cleanName = invoicename === "" ? null : invoicename;
    const cleanCurrency = currency === "" ? null : currency;
    const cleanAmount = amount === "" ? null : amount;
    const result = await db.query(
      "UPDATE invoices SET invoicename = COALESCE($1, invoicename), currency = COALESCE($2, currency), amount = COALESCE($3, amount) WHERE invoicenumber = $4 RETURNING *",
      [cleanName, cleanCurrency, cleanAmount, invoice_number],
    );
    if (result.rows.length === 0) {
      console.log(`No Invoice Found`);
    }
    const editedInvoice = result.rows;
    res.status(200).json({ invoice: editedInvoice });
  } catch (error) {
    // res.json(500).json({ message: `Error Editing Invoice` });
    console.log(error.message);
  }
});

router.get("/link/:id", async (req, res) => {
  const invoice_number = req.params.id;
  try {
    const result = await db.query(
      "SELECT * FROM invoices WHERE invoicenumber =$1",
      [invoice_number],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Invoice not found." });
    }
    const invoice_details = result.rows[0];

    // Check if this invoice has expired and is still unpaid &mdash; auto-mark it as expired
    if (
      invoice_details.expires_at &&
      new Date() > new Date(invoice_details.expires_at) &&
      invoice_details.status === "pending"
    ) {
      await db.query(
        "UPDATE invoices SET status = 'expired' WHERE invoicenumber = $1",
        [invoice_number],
      );
      invoice_details.status = "expired";
    }

    // Fire "invoice viewed" notification to seller &mdash; only on first view (fire-and-forget)
    if (!invoice_details.viewed_at) {
      invoice_details.viewed_at = new Date();
      db.query(
        "UPDATE invoices SET viewed_at = NOW() WHERE invoicenumber = $1",
        [invoice_number],
      ).catch(() => {});
      db.query(
        `INSERT INTO notifications (userid, type, title, body, data, is_read)
         VALUES ($1, 'invoice_viewed', $2, $3, $4, false)`,
        [
          invoice_details.userid,
          "Invoice Viewed",
          `Your invoice ${invoice_number} was viewed by the buyer just now.`,
          JSON.stringify({ invoice_number }),
        ],
      ).catch(() => {});
    }

    return res.status(200).json({ invoice_details: invoice_details });
  } catch (error) {
    console.log(error.message);
    return res.status(500).json({
      message: "Failed to retrieve invoice details. Please try again.",
    });
  }
});

router.patch("/mark-delivered/:id", async (req, res) => {
  const invoiceId = req.params.id;

  try {
    // 1. Get the invoice
    const invoiceCheck = await db.query(
      "SELECT * FROM invoices WHERE id = $1",
      [invoiceId],
    );
    if (invoiceCheck.rows.length === 0) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const invoice = invoiceCheck.rows[0];

    // 2. Only allow marking as delivered if the buyer has already paid (status = 'paid')
    if (invoice.status !== "paid") {
      return res.status(403).json({
        message:
          "You can only mark an invoice as delivered after the buyer has made a payment.",
      });
    }

    // 3. Update the invoice status to 'delivered' and save the exact delivery time
    //    (the delivered_at timestamp is used later to enforce the 48-hour dispute rule for sellers)
    await db.query(
      "UPDATE invoices SET status = 'delivered', delivered_at = NOW() WHERE id = $1",
      [invoiceId],
    );

    // 4. Get the buyer's email from the guests table
    const guestCheck = await db.query(
      "SELECT * FROM guests WHERE invoicenumber = $1",
      [invoice.invoicenumber],
    );
    if (guestCheck.rows.length === 0) {
      console.log("No buyer email found for this invoice");
      return res.status(200).json({
        message: "Invoice marked as delivered, but buyer email not found.",
      });
    }

    const buyerEmail = guestCheck.rows[0].email;

    // 5. Send email to the buyer informing them the seller has marked the order as delivered
    const deliveryNotificationMsg = {
      to: buyerEmail,
      from: process.env.VERIFIED_SENDER,
      subject: `Action Required: Confirm Your Delivery  - Invoice ${invoice.invoicenumber} | Fonlok`,
      html: emailWrap(
        `<h2 style="color:#0F1F3D;margin:0 0 12px;">Action Required &mdash; Your Order Has Been Delivered</h2>
        <p style="color:#475569;">The seller has marked the following invoice as <strong>delivered</strong>. Please check that you have received everything before releasing the funds.</p>
        ${emailTable([
          ["Invoice Number", invoice.invoicenumber],
          ["Invoice Name", invoice.invoicename],
          [
            "Amount",
            `${invoice.amount} ${invoice.currency}`,
            "font-weight:700;color:#16a34a;font-size:15px;",
          ],
        ])}
        <p style="color:#475569;"><strong>Satisfied with your order?</strong> Log in and release the funds to the seller.</p>
        <p style="color:#dc2626;font-weight:600;">If you have NOT received your order, do not release the funds and contact the seller immediately.</p>`,
        {
          footerNote:
            "You received this email because a seller marked their invoice as delivered on Fonlok Escrow.",
        },
      ),
    };

    try {
      await sgMail.send(deliveryNotificationMsg);
      console.log("✅ Delivery notification email sent to buyer.");
    } catch (error) {
      console.error(
        "❌ Delivery Email Error:",
        error.response ? error.response.body : error.message,
      );
    }

    return res.status(200).json({
      message: "Invoice marked as delivered and buyer has been notified.",
    });
  } catch (error) {
    console.log(error.message);
    return res
      .status(500)
      .json({ message: "Something went wrong. Please try again." });
  }
});

// --- GET MILESTONES for an invoice ---
router.get("/milestones/:invoice_number", async (req, res) => {
  const { invoice_number } = req.params;
  try {
    const invoiceResult = await db.query(
      "SELECT id FROM invoices WHERE invoicenumber = $1",
      [invoice_number],
    );
    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ message: "Invoice not found." });
    }
    const invoice_id = invoiceResult.rows[0].id;
    const milestones = await db.query(
      "SELECT * FROM invoice_milestones WHERE invoice_id = $1 ORDER BY milestone_number ASC",
      [invoice_id],
    );
    return res.status(200).json({ milestones: milestones.rows });
  } catch (error) {
    console.log(error.message);
    return res.status(500).json({ message: "Failed to retrieve milestones." });
  }
});

// --- SELLER MARKS A MILESTONE COMPLETE ---
// Generates a release_token and emails the buyer a one-click release link
router.patch("/milestone/:milestone_id/complete", async (req, res) => {
  const { milestone_id } = req.params;
  try {
    // 1. Get the milestone
    const msResult = await db.query(
      "SELECT * FROM invoice_milestones WHERE id = $1",
      [milestone_id],
    );
    if (msResult.rows.length === 0) {
      return res.status(404).json({ message: "Milestone not found." });
    }
    const milestone = msResult.rows[0];

    if (milestone.status !== "pending") {
      return res.status(400).json({
        message: `This milestone is already marked as '${milestone.status}'.`,
      });
    }

    // 2. Enforce ordering: all previous milestones must be 'released' before this one can be marked complete
    if (milestone.milestone_number > 1) {
      const prevCheck = await db.query(
        "SELECT * FROM invoice_milestones WHERE invoice_id = $1 AND milestone_number < $2 AND status != 'released'",
        [milestone.invoice_id, milestone.milestone_number],
      );
      if (prevCheck.rows.length > 0) {
        return res.status(400).json({
          message:
            "Previous milestones must be released before marking this one complete.",
        });
      }
    }

    // 3. Get the invoice (for details in the email)
    const invoiceResult = await db.query(
      "SELECT * FROM invoices WHERE id = $1",
      [milestone.invoice_id],
    );
    const invoice = invoiceResult.rows[0];

    // 4. Get buyer email from guests table
    const guestResult = await db.query(
      "SELECT * FROM guests WHERE invoicenumber = $1",
      [milestone.invoice_number],
    );
    if (guestResult.rows.length === 0) {
      return res.status(400).json({
        message: "Buyer information not found. Has the buyer paid yet?",
      });
    }
    const buyerEmail = guestResult.rows[0].email;

    // 5. Generate a unique release token
    const releaseToken = crypto.randomBytes(32).toString("hex");

    // 6. Save the token and mark milestone as 'completed'
    await db.query(
      "UPDATE invoice_milestones SET status = 'completed', release_token = $1, completed_at = NOW() WHERE id = $2",
      [releaseToken, milestone_id],
    );

    // 7. Build the release link &mdash; buyer clicks this to release funds for this milestone
    const releaseLink = `${process.env.BACKEND_URL}/api/release-milestone/${releaseToken}`;

    // 8. Send email to buyer
    const msg = {
      to: buyerEmail,
      from: process.env.VERIFIED_SENDER,
      subject: `Action Required: Confirm Milestone ${milestone.milestone_number}  - ${invoice.invoicenumber} | Fonlok`,
      html: emailWrap(
        `<h2 style="color:#0F1F3D;margin:0 0 12px;">Milestone ${milestone.milestone_number} &mdash; Action Required</h2>
        <p style="color:#475569;">The seller has marked <strong>Milestone ${milestone.milestone_number}: ${milestone.label}</strong> as complete for invoice <strong>${invoice.invoicename}</strong>.</p>
        ${emailTable([
          ["Invoice", invoice.invoicenumber],
          ["Milestone", milestone.label],
          [
            "Amount to Release",
            `${milestone.amount} XAF`,
            "font-weight:700;color:#16a34a;font-size:15px;",
          ],
        ])}
        <p style="color:#475569;">If you have received what was agreed for this milestone, click the button below to release the funds:</p>
        ${emailButton(releaseLink, `Confirm &amp; Release ${milestone.amount} XAF`)}
        <p style="color:#dc2626;font-weight:600;">Do NOT click if you have not received this part of your order. If there is a problem, open a dispute from your invoice link.</p>`,
        {
          footerNote:
            "This link can only be used once. Keep it private. You received this email because a seller marked a milestone as complete on Fonlok.",
        },
      ),
    };

    try {
      await sgMail.send(msg);
      console.log(
        `✅ Milestone completion email sent to ${buyerEmail} for milestone ${milestone_id}`,
      );
    } catch (emailErr) {
      console.error(
        "❌ Milestone email error:",
        emailErr.response?.body || emailErr.message,
      );
    }

    return res.status(200).json({
      message: `Milestone ${milestone.milestone_number} marked as complete. The buyer has been emailed a release link.`,
    });
  } catch (error) {
    console.log(error.message);
    return res
      .status(500)
      .json({ message: "Something went wrong. Please try again." });
  }
});

// --- STATS ROUTE: Returns invoice counts and revenue/spending for the dashboard ---
router.get("/stats/:id", async (req, res) => {
  const userId = req.params.id;

  try {
    // 1. Count all invoices grouped by status (for the seller view)
    const allInvoices = await db.query(
      "SELECT COUNT(*) AS total FROM invoices WHERE userid = $1",
      [userId],
    );
    const paidInvoices = await db.query(
      "SELECT COUNT(*) AS total FROM invoices WHERE userid = $1 AND status = 'paid'",
      [userId],
    );
    const pendingInvoices = await db.query(
      "SELECT COUNT(*) AS total FROM invoices WHERE userid = $1 AND status = 'pending'",
      [userId],
    );
    const deliveredInvoices = await db.query(
      "SELECT COUNT(*) AS total FROM invoices WHERE userid = $1 AND status = 'delivered'",
      [userId],
    );

    // 2. Calculate total revenue made (sum of all amounts from the payouts table)
    const revenueResult = await db.query(
      "SELECT COALESCE(SUM(amount), 0) AS total_revenue FROM payouts WHERE userid = $1 AND status = 'paid'",
      [userId],
    );

    // 3. Calculate total amount spent as a buyer
    //    We look for invoices that were paid where the buyer's guest record is linked to this user's account
    const spentResult = await db.query(
      `SELECT COALESCE(SUM(invoices.amount), 0) AS total_spent
       FROM invoices
       JOIN guests ON guests.invoicenumber = invoices.invoicenumber
       WHERE guests.registered_userid = $1`,
      [userId],
    );

    return res.status(200).json({
      totalInvoices: parseInt(allInvoices.rows[0].total),
      paidInvoices: parseInt(paidInvoices.rows[0].total),
      pendingInvoices: parseInt(pendingInvoices.rows[0].total),
      deliveredInvoices: parseInt(deliveredInvoices.rows[0].total),
      totalRevenue: parseFloat(revenueResult.rows[0].total_revenue),
      totalSpent: parseFloat(spentResult.rows[0].total_spent),
    });
  } catch (error) {
    console.log(error.message);
    return res.status(500).json({ message: "Something went wrong." });
  }
});

// --- ESCROW BALANCE: Funds currently held in escrow for this seller ---
// Returns the gross amount, the net amount after the 3% Fonlok fee, and
// the number of invoices whose funds are waiting to be released.
router.get("/escrow-balance/:id", async (req, res) => {
  const userId = req.params.id;
  try {
    const result = await db.query(
      `SELECT
         COUNT(DISTINCT i.id)        AS invoice_count,
         COALESCE(SUM(p.amount), 0)  AS gross_amount
       FROM invoices i
       JOIN payments p ON p.invoiceid = i.id
       WHERE i.userid = $1
         AND i.status IN ('paid', 'delivered')
         AND p.status  = 'paid'`,
      [userId],
    );
    const gross = parseFloat(result.rows[0].gross_amount);
    const net = Math.floor(gross * 0.97); // deduct 3% platform fee
    return res.status(200).json({
      invoiceCount: parseInt(result.rows[0].invoice_count),
      grossAmount: gross,
      netAmount: net,
    });
  } catch (err) {
    console.error("Escrow balance error:", err.message);
    return res.status(500).json({ message: "Could not load escrow balance." });
  }
});

// POST /invoice/resend-email/:invoice_number
// Seller-only: resend the buyer's release email (delivery notification or milestone release link).
// Useful when the buyer's email bounced or they accidentally deleted it.
router.post(
  "/resend-email/:invoice_number",
  authMiddleware,
  async (req, res) => {
    const { invoice_number } = req.params;
    const sellerId = req.user.id;

    try {
      // 1. Fetch invoice and verify the authenticated user is the seller
      const invResult = await db.query(
        "SELECT * FROM invoices WHERE invoicenumber = $1",
        [invoice_number],
      );
      if (invResult.rows.length === 0) {
        return res.status(404).json({ message: "Invoice not found." });
      }
      const invoice = invResult.rows[0];
      if (invoice.userid !== sellerId) {
        return res
          .status(403)
          .json({ message: "You are not authorised to manage this invoice." });
      }

      // 2. Fetch the buyer from the guests table
      const guestResult = await db.query(
        "SELECT * FROM guests WHERE invoicenumber = $1 ORDER BY created_at DESC LIMIT 1",
        [invoice_number],
      );
      if (guestResult.rows.length === 0) {
        return res
          .status(400)
          .json({ message: "Buyer has not made a payment yet." });
      }
      const buyer = guestResult.rows[0];

      // ── INSTALLMENT INVOICE ──────────────────────────────────────────────────
      if (invoice.payment_type === "installment") {
        const completedMs = await db.query(
          `SELECT im.*, i.invoicename, i.invoicenumber
         FROM invoice_milestones im
         JOIN invoices i ON i.id = im.invoice_id
         WHERE im.invoice_id = $1
           AND im.status = 'completed'
           AND im.release_token IS NOT NULL`,
          [invoice.id],
        );
        if (completedMs.rows.length === 0) {
          return res.status(400).json({
            message:
              "No pending milestone confirmations to resend. All milestones are either unreleased-pending or already released.",
          });
        }

        // Resend the release email for every awaiting milestone
        const sends = completedMs.rows.map((ms) => {
          const releaseLink = `${process.env.BACKEND_URL}/api/release-milestone/${ms.release_token}`;
          return sgMail.send({
            to: buyer.email,
            from: process.env.VERIFIED_SENDER,
            subject: `Milestone Reminder: Please Confirm Milestone ${ms.milestone_number}  - ${ms.invoicenumber} | Fonlok`,
            html: emailWrap(
              `<h2 style="color:#0F1F3D;margin:0 0 12px;">Reminder &mdash; Milestone ${ms.milestone_number}: ${ms.label}</h2>
              <p style="color:#475569;">This is a reminder that <strong>Milestone ${ms.milestone_number}: ${ms.label}</strong> for invoice <strong>${ms.invoicename}</strong> (${ms.invoicenumber}) has been marked as complete and is awaiting your confirmation.</p>
              ${emailTable([
                ["Invoice", ms.invoicenumber],
                ["Milestone", ms.label],
                [
                  "Amount to Release",
                  `${Number(ms.amount).toLocaleString()} XAF`,
                  "font-weight:700;color:#16a34a;font-size:15px;",
                ],
              ])}
              <p style="color:#475569;">If you have received what was agreed, click the button below to release the funds:</p>
              ${emailButton(releaseLink, `Confirm &amp; Release ${Number(ms.amount).toLocaleString()} XAF`)}
              <p style="color:#dc2626;font-weight:600;">Do NOT click if you have not received this part of your order.</p>`,
              {
                footerNote:
                  "This link can only be used once. Keep it private. You are receiving this because your seller asked us to resend the confirmation.",
              },
            ),
          });
        });

        try {
          await Promise.all(sends);
          console.log(
            `✅ Resent ${completedMs.rows.length} milestone email(s) for ${invoice_number}`,
          );
        } catch (emailErr) {
          console.error(
            "❌ Resend milestone email error:",
            emailErr.response?.body || emailErr.message,
          );
          return res
            .status(500)
            .json({ message: "Failed to resend email. Please try again." });
        }

        return res.status(200).json({
          message: `Release email${completedMs.rows.length > 1 ? "s" : ""} resent to ${buyer.email}.`,
        });
      }

      // ── REGULAR (ONE-TIME) INVOICE ───────────────────────────────────────────
      if (invoice.status !== "delivered") {
        return res.status(400).json({
          message: "Resend is only available for delivered invoices.",
        });
      }

      const invoicePageLink = `${process.env.FRONTEND_URL}/invoice/${invoice_number}`;
      try {
        await sgMail.send({
          to: buyer.email,
          from: process.env.VERIFIED_SENDER,
          subject: `Delivery Reminder: Please Release Funds  - Invoice ${invoice_number} | Fonlok`,
          html: emailWrap(
            `<h2 style="color:#0F1F3D;margin:0 0 12px;">Reminder &mdash; Your Order Has Been Delivered</h2>
            <p style="color:#475569;">The seller has marked invoice <strong>${invoice.invoicename}</strong> (${invoice_number}) as <strong>delivered</strong>. Please check that you received everything before releasing the funds.</p>
            ${emailTable([
              ["Invoice Number", invoice_number],
              ["Invoice Name", invoice.invoicename],
              [
                "Amount",
                `${Number(invoice.amount).toLocaleString()} ${invoice.currency}`,
                "font-weight:700;color:#16a34a;font-size:15px;",
              ],
            ])}
            <p style="color:#475569;">If you have received your order, log in and release the funds to the seller:</p>
            ${emailButton(invoicePageLink, "View Invoice &amp; Release Funds")}
            <p style="color:#dc2626;font-weight:600;">If you have NOT received your order, do not release the funds and contact the seller to resolve the issue.</p>`,
            {
              footerNote:
                "You are receiving this reminder because your seller asked us to resend the delivery notification.",
            },
          ),
        });
        console.log(
          `✅ Resent delivery email for ${invoice_number} to ${buyer.email}`,
        );
      } catch (emailErr) {
        console.error(
          "❌ Resend delivery email error:",
          emailErr.response?.body || emailErr.message,
        );
        return res
          .status(500)
          .json({ message: "Failed to resend email. Please try again." });
      }

      return res
        .status(200)
        .json({ message: `Delivery reminder sent to ${buyer.email}.` });
    } catch (error) {
      console.log(error.message);
      return res
        .status(500)
        .json({ message: "Something went wrong. Please try again." });
    }
  },
);

// GET /invoice/receipt/:invoice_number
// Download a professional PDF receipt (accessible by both seller and buyer)
router.get("/receipt/:invoice_number", async (req, res) => {
  const { invoice_number } = req.params;

  try {
    // Use the shared PDF utility (utils/generateReceipt.js)
    const pdfBuffer = await generateReceiptPdf(invoice_number);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="fonlok-receipt-${invoice_number}.pdf"`,
    );
    return res.send(pdfBuffer);
  } catch (error) {
    const msg = (error.message || "").toLowerCase();
    if (msg.includes("not found")) {
      return res.status(404).json({ message: "Invoice not found." });
    }
    if (msg.includes("not available") || msg.includes("status")) {
      return res.status(403).json({
        message:
          "Receipt is only available for paid, delivered, or completed invoices.",
      });
    }
    console.error("Receipt generation error:", error.message);
    return res
      .status(500)
      .json({ message: "Failed to generate receipt. Please try again." });
  }
});

// GET /invoice/my-purchases &mdash; Buyer portal: all invoices this user has paid for
router.get("/my-purchases", authMiddleware, async (req, res) => {
  const buyerId = req.user.id;
  try {
    const result = await db.query(
      `SELECT
         i.invoicenumber,
         i.invoicename,
         i.amount,
         i.currency,
         i.status,
         i.createdat,
         i.paid_at,
         i.delivered_at,
         i.payment_type,
         i.description,
         u.name        AS seller_name,
         u.username    AS seller_username,
         u.profilepicture AS seller_avatar
       FROM invoices i
       JOIN guests g ON g.invoicenumber = i.invoicenumber
       JOIN users  u ON u.id = i.userid
       WHERE g.registered_userid = $1
       ORDER BY i.createdat DESC`,
      [buyerId],
    );
    return res.status(200).json({ purchases: result.rows });
  } catch (error) {
    console.log(error.message);
    return res
      .status(500)
      .json({ message: "Failed to load purchases. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /invoice/verify  — Public. Verify a Fonlok receipt by invoice number + code.
// Body: { invoice_number: string, code: string }
// Returns full receipt details when the code is authentic; error otherwise.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/verify", async (req, res) => {
  const raw_number = (req.body.invoice_number || "").toString().trim();
  const raw_code = (req.body.code || "").toString().trim().toUpperCase();

  if (!raw_number || !raw_code) {
    return res.status(400).json({
      verified: false,
      message: "Invoice number and code are required.",
    });
  }

  // Recompute the expected code for this invoice number
  const expected = crypto
    .createHash("sha256")
    .update(raw_number + (process.env.JWT_SECRET || "fonlok"))
    .digest("hex")
    .substring(0, 16)
    .toUpperCase();

  if (raw_code !== expected) {
    return res.status(200).json({
      verified: false,
      message:
        "Verification failed. This code does not match our records — the receipt may have been altered or is not from Fonlok.",
    });
  }

  // Code matches — fetch the invoice
  try {
    const result = await db.query(
      `SELECT
         i.invoicenumber,
         i.invoicename,
         i.amount,
         i.currency,
         i.status,
         i.payment_type,
         i.createdat,
         i.paid_at,
         i.description,
         u.name  AS seller_name,
         u.username AS seller_username,
         u.country AS seller_country
       FROM invoices i
       JOIN users u ON u.id = i.userid
       WHERE i.invoicenumber = $1`,
      [raw_number],
    );

    if (result.rows.length === 0) {
      return res.status(200).json({
        verified: false,
        message:
          "Verification failed. No invoice with that number exists in our system.",
      });
    }

    const inv = result.rows[0];

    // Only valid if invoice is paid/delivered/completed
    const validStatuses = ["paid", "delivered", "completed"];
    if (!validStatuses.includes(inv.status)) {
      return res.status(200).json({
        verified: false,
        message: `Receipt cannot be verified — invoice status is "${inv.status}". Only paid or completed invoices carry a valid receipt.`,
      });
    }

    return res.status(200).json({
      verified: true,
      invoice: {
        invoice_number: inv.invoicenumber,
        invoice_name: inv.invoicename,
        amount: inv.amount,
        currency: inv.currency,
        status: inv.status,
        payment_type: inv.payment_type,
        created_at: inv.createdat,
        paid_at: inv.paid_at,
        description: inv.description,
        seller_name: inv.seller_name,
        seller_username: inv.seller_username,
        seller_country: inv.seller_country,
      },
    });
  } catch (err) {
    console.error("Receipt verify error:", err.message);
    return res.status(500).json({
      verified: false,
      message: "Verification failed. Please try again later.",
    });
  }
});

export default router;
