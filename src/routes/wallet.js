/**
 * wallet.js — Wallet/vault API routes for platform integrations (e.g. Njimbong).
 *
 * Mounted at /v1 in server.js. All routes require a valid sk_live_* API key.
 *
 * Routes:
 *   POST /v1/wallet/deposit/initiate          — Initiate MoMo collection to top up wallet
 *   GET  /v1/wallet/deposit/:reference/status — Poll deposit; credits wallet on success
 *   GET  /v1/wallet/balance                   — Get current balance for a user_ref
 *   POST /v1/wallet/withdraw                  — Withdraw from wallet to MoMo
 *   POST /v1/wallet/pay                       — Fund an escrow invoice from wallet balance
 *
 * Fee structure:
 *   Deposit  : 1.5% added to the requested amount (charged to user, Fonlok keeps 1.5%)
 *   Withdraw : 0% to user — Fonlok covers Campay's 1% disbursement fee
 *              Net per round-trip: Fonlok earns 0.5% (1.5% in − 1% out)
 *   Escrow pay: 0% at funding; normal 2% release fee applies when seller is paid out
 */

import express from "express";
import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import db from "../controllers/db.js";
import sgMail from "@sendgrid/mail";
import { body } from "express-validator";
import { validate } from "../middleware/validate.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import logger from "../utils/logger.js";
import { emailWrap, emailTable, emailButton, emailButtonDanger } from "../utils/emailTemplate.js";
import { generateReceiptPdf } from "../utils/generateReceipt.js";
import { buildEmailCopy } from "../utils/emailLanguageCopy.js";

dotenv.config();
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const router = express.Router();

// Every wallet route requires a valid live API key.
router.use(apiKeyAuth);

// ── Fee constants ─────────────────────────────────────────────────────────────
const DEPOSIT_FEE_RATE = 0.015; // 1.5% added on top of deposit amount
const CAMPAY_FEE_RATE = 0.01; // 1% Campay deducts on disbursements (we cover this)

// ── Internal helpers ──────────────────────────────────────────────────────────

async function getCampayToken() {
  const res = await axios.post(
    `${process.env.CAMPAY_BASE_URL}token/`,
    {
      username: process.env.CAMPAY_USERNAME,
      password: process.env.CAMPAY_PASSWORD,
    },
    { timeout: 10000 },
  );
  return res.data.token;
}

/** Get or create a wallet for (platformUserId, userRef). */
async function getOrCreateWallet(platformUserId, userRef) {
  const res = await db.query(
    `INSERT INTO wallets (platform_user_id, user_ref)
     VALUES ($1, $2)
     ON CONFLICT (platform_user_id, user_ref)
     DO UPDATE SET user_ref = EXCLUDED.user_ref
     RETURNING *`,
    [platformUserId, userRef],
  );
  return res.rows[0];
}

/** Generate an 8-character alphanumeric release code (no ambiguous chars). */
function generate8CharCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(
    { length: 8 },
    () => chars[Math.floor(Math.random() * chars.length)],
  ).join("");
}

// ─── POST /v1/wallet/deposit/initiate ────────────────────────────────────────
//
// Initiates a Campay MoMo collection request.
// The user is charged: amount + ceil(amount × 1.5%)
// Their wallet is credited: amount (on confirmation)
//
// Poll GET /v1/wallet/deposit/:reference/status to confirm.
router.post(
  "/wallet/deposit/initiate",
  [
    body("amount")
      .isInt({ min: 100 })
      .withMessage("amount must be an integer XAF value >= 100."),
    body("phone").trim().notEmpty().withMessage("phone is required."),
    body("user_ref").trim().notEmpty().withMessage("user_ref is required."),
    body("description").optional().trim().isString(),
  ],
  validate,
  async (req, res) => {
    const platformUserId = req.apiKey.user_id;
    const { phone, user_ref, description } = req.body;
    const amount = parseInt(req.body.amount, 10);

    // 1.5% fee added on top — user pays amount + fee, wallet gets credited amount
    const depositFee = Math.ceil(amount * DEPOSIT_FEE_RATE);
    const chargedAmount = amount + depositFee;

    try {
      const wallet = await getOrCreateWallet(platformUserId, user_ref);

      // Create pending transaction record before calling Campay
      const txRes = await db.query(
        `INSERT INTO wallet_transactions
           (wallet_id, type, gross_amount, net_amount, fee_amount, status, description)
         VALUES ($1, 'deposit', $2, $3, $4, 'pending', $5)
         RETURNING id`,
        [
          wallet.id,
          chargedAmount,
          amount,
          depositFee,
          description || `Wallet top-up — ${user_ref}`,
        ],
      );
      const txId = txRes.rows[0].id;

      // Authenticate with Campay
      let campayToken;
      try {
        campayToken = await getCampayToken();
      } catch (authErr) {
        await db
          .query("DELETE FROM wallet_transactions WHERE id = $1", [txId])
          .catch(() => {});
        logger.error("Campay auth failed for wallet deposit", {
          error: authErr.message,
        });
        return res.status(502).json({
          error: "payment_gateway_error",
          message:
            "Could not connect to the payment gateway. Please try again.",
        });
      }

      // Initiate collection
      let collectRef;
      try {
        const collectRes = await axios.post(
          `${process.env.CAMPAY_BASE_URL}collect/`,
          {
            amount: String(chargedAmount),
            currency: "XAF",
            from: phone,
            description: description || "Fonlok wallet top-up",
            external_reference: `WALLET-DEP-${txId}`,
          },
          {
            headers: { Authorization: `Token ${campayToken}` },
            timeout: 30000,
          },
        );
        collectRef = collectRes.data.reference;
      } catch (collectErr) {
        await db
          .query("DELETE FROM wallet_transactions WHERE id = $1", [txId])
          .catch(() => {});
        logger.error("Campay collect failed for wallet deposit", {
          error: collectErr.message,
        });
        return res.status(502).json({
          error: "payment_gateway_error",
          message: "Could not initiate payment collection. Please try again.",
        });
      }

      // Store Campay reference for polling
      await db.query(
        "UPDATE wallet_transactions SET campay_reference = $1 WHERE id = $2",
        [collectRef, txId],
      );

      return res.status(202).json({
        transaction_id: txId,
        reference: collectRef,
        user_ref,
        amount_requested: amount,
        amount_charged: chargedAmount,
        fee: depositFee,
        currency: "XAF",
        status: "pending",
        message:
          "Payment prompt sent to user's phone. Poll GET /v1/wallet/deposit/:reference/status to confirm.",
      });
    } catch (err) {
      logger.error("Wallet deposit initiate error", { error: err.message });
      return res.status(500).json({
        error: "server_error",
        message: "An unexpected error occurred.",
      });
    }
  },
);

// ─── GET /v1/wallet/deposit/:reference/status ────────────────────────────────
//
// Polls Campay for the status of a pending deposit.
// On first SUCCESSFUL response: credits the wallet and marks transaction completed.
// Idempotent — safe to call multiple times.
router.get("/wallet/deposit/:reference/status", async (req, res) => {
  const { reference } = req.params;
  const platformUserId = req.apiKey.user_id;

  try {
    const txRes = await db.query(
      `SELECT wt.*, w.platform_user_id, w.user_ref, w.id AS wallet_id
         FROM wallet_transactions wt
         JOIN wallets w ON wt.wallet_id = w.id
         WHERE wt.campay_reference = $1 AND wt.type = 'deposit'
         LIMIT 1`,
      [reference],
    );
    if (txRes.rows.length === 0) {
      return res.status(404).json({
        error: "not_found",
        message: "No deposit found for this reference.",
      });
    }
    const tx = txRes.rows[0];
    if (tx.platform_user_id !== platformUserId) {
      return res.status(403).json({
        error: "forbidden",
        message: "This transaction does not belong to your account.",
      });
    }

    // Return cached status if already settled
    if (tx.status === "completed") {
      return res.json({
        reference,
        status: "completed",
        amount_credited: tx.net_amount,
        transaction_id: tx.id,
        user_ref: tx.user_ref,
      });
    }
    if (tx.status === "failed") {
      return res.json({
        reference,
        status: "failed",
        transaction_id: tx.id,
        user_ref: tx.user_ref,
      });
    }

    // Ask Campay for current status
    let campayToken;
    try {
      campayToken = await getCampayToken();
    } catch {
      return res.status(502).json({
        error: "payment_gateway_error",
        message: "Could not connect to payment gateway.",
      });
    }

    let campayStatus;
    try {
      const statusRes = await axios.get(
        `${process.env.CAMPAY_BASE_URL}transaction/${reference}/`,
        { headers: { Authorization: `Token ${campayToken}` }, timeout: 10000 },
      );
      campayStatus = statusRes.data.status; // "SUCCESSFUL" | "FAILED" | "PENDING"
    } catch (statusErr) {
      return res.status(502).json({
        error: "payment_gateway_error",
        message: "Could not retrieve payment status from gateway.",
      });
    }

    if (campayStatus === "SUCCESSFUL") {
      // Atomically mark completed and credit wallet.
      // The AND status = 'pending' guard prevents double-crediting.
      const updateRes = await db.query(
        `UPDATE wallet_transactions
           SET status = 'completed'
           WHERE id = $1 AND status = 'pending'
           RETURNING id`,
        [tx.id],
      );
      if (updateRes.rowCount > 0) {
        // First confirmation — credit the wallet
        await db.query(
          "UPDATE wallets SET balance = balance + $1 WHERE id = $2",
          [tx.net_amount, tx.wallet_id],
        );
      }
      return res.json({
        reference,
        status: "completed",
        amount_credited: tx.net_amount,
        transaction_id: tx.id,
        user_ref: tx.user_ref,
      });
    } else if (campayStatus === "FAILED") {
      await db
        .query(
          "UPDATE wallet_transactions SET status = 'failed' WHERE id = $1",
          [tx.id],
        )
        .catch(() => {});
      return res.json({
        reference,
        status: "failed",
        transaction_id: tx.id,
        user_ref: tx.user_ref,
      });
    } else {
      return res.json({
        reference,
        status: "pending",
        transaction_id: tx.id,
        user_ref: tx.user_ref,
      });
    }
  } catch (err) {
    logger.error("Wallet deposit status check failed", { error: err.message });
    return res.status(500).json({
      error: "server_error",
      message: "An unexpected error occurred.",
    });
  }
});

// ─── GET /v1/wallet/balance ───────────────────────────────────────────────────
//
// Returns the current wallet balance for a user_ref.
// Returns 0 if no wallet exists yet (first deposit creates the wallet).
router.get("/wallet/balance", async (req, res) => {
  const platformUserId = req.apiKey.user_id;
  const { user_ref } = req.query;

  if (!user_ref?.trim()) {
    return res.status(400).json({
      error: "validation_error",
      message: "user_ref query parameter is required.",
    });
  }

  try {
    const result = await db.query(
      "SELECT balance, currency FROM wallets WHERE platform_user_id = $1 AND user_ref = $2",
      [platformUserId, user_ref.trim()],
    );
    return res.json({
      user_ref: user_ref.trim(),
      balance: result.rows[0]?.balance ?? 0,
      currency: result.rows[0]?.currency ?? "XAF",
    });
  } catch (err) {
    logger.error("Wallet balance fetch failed", { error: err.message });
    return res.status(500).json({
      error: "server_error",
      message: "An unexpected error occurred.",
    });
  }
});

// ─── POST /v1/wallet/withdraw ─────────────────────────────────────────────────
//
// Withdraws funds from wallet directly to a MoMo number.
// No fee charged to the user: Fonlok covers Campay's 1% disbursement fee.
// Fonlok net per deposit→withdraw round-trip: 0.5% (1.5% deposit − 1% Campay cover).
//
// Atomic debit prevents overdraft. Balance is restored if Campay fails.
router.post(
  "/wallet/withdraw",
  [
    body("amount")
      .isInt({ min: 100 })
      .withMessage("amount must be an integer XAF value >= 100."),
    body("phone").trim().notEmpty().withMessage("phone is required."),
    body("user_ref").trim().notEmpty().withMessage("user_ref is required."),
    body("description").optional().trim().isString(),
  ],
  validate,
  async (req, res) => {
    const platformUserId = req.apiKey.user_id;
    const { phone, user_ref, description } = req.body;
    const amount = parseInt(req.body.amount, 10);

    // Gross-up so user receives exactly 'amount' after Campay deducts its fee.
    // Campay charges ceil(gross * rate) on the amount it receives, not on 'amount',
    // so: campayAmount = ceil(amount / (1 - rate)), campayFee = campayAmount - amount.
    const campayAmount = Math.ceil(amount / (1 - CAMPAY_FEE_RATE));
    const campayFee = campayAmount - amount;

    try {
      // Atomic debit — WHERE balance >= amount prevents overdraft
      const debitRes = await db.query(
        `UPDATE wallets
         SET balance = balance - $1
         WHERE platform_user_id = $2 AND user_ref = $3 AND balance >= $1
         RETURNING id, balance`,
        [amount, platformUserId, user_ref],
      );
      if (debitRes.rows.length === 0) {
        const check = await db.query(
          "SELECT balance FROM wallets WHERE platform_user_id = $1 AND user_ref = $2",
          [platformUserId, user_ref],
        );
        if (check.rows.length === 0) {
          return res.status(404).json({
            error: "wallet_not_found",
            message: `No wallet found for user_ref '${user_ref}'.`,
          });
        }
        return res.status(409).json({
          error: "insufficient_funds",
          message: `Wallet balance (${check.rows[0].balance} XAF) is less than the requested withdrawal (${amount} XAF).`,
          current_balance: check.rows[0].balance,
        });
      }

      const walletId = debitRes.rows[0].id;
      const newBalance = debitRes.rows[0].balance;

      // Create transaction record
      const txRes = await db.query(
        `INSERT INTO wallet_transactions
           (wallet_id, type, gross_amount, net_amount, fee_amount, status, description)
         VALUES ($1, 'withdrawal', $2, $3, $4, 'pending', $5)
         RETURNING id`,
        [
          walletId,
          campayAmount,
          amount,
          campayFee,
          description || `Wallet withdrawal — ${user_ref}`,
        ],
      );
      const txId = txRes.rows[0].id;

      // Campay auth
      let campayToken;
      try {
        campayToken = await getCampayToken();
      } catch (authErr) {
        await db
          .query("UPDATE wallets SET balance = balance + $1 WHERE id = $2", [
            amount,
            walletId,
          ])
          .catch(() => {});
        await db
          .query(
            "UPDATE wallet_transactions SET status = 'failed' WHERE id = $1",
            [txId],
          )
          .catch(() => {});
        return res.status(502).json({
          error: "payment_gateway_error",
          message: "Could not connect to the payment gateway.",
        });
      }

      // Disburse via Campay
      let campayRef;
      try {
        const wdrRes = await axios.post(
          `${process.env.CAMPAY_BASE_URL}withdraw/`,
          {
            amount: String(campayAmount),
            currency: "XAF",
            to: phone,
            description: description || "Fonlok wallet withdrawal",
            external_reference: `WALLET-WDR-${txId}`,
          },
          {
            headers: { Authorization: `Token ${campayToken}` },
            timeout: 15000,
          },
        );
        campayRef = wdrRes.data.reference;
      } catch (wdrErr) {
        // Restore balance — Campay never received the money
        await db
          .query("UPDATE wallets SET balance = balance + $1 WHERE id = $2", [
            amount,
            walletId,
          ])
          .catch(() => {});
        await db
          .query(
            "UPDATE wallet_transactions SET status = 'failed' WHERE id = $1",
            [txId],
          )
          .catch(() => {});
        logger.error("Campay withdraw failed for wallet", {
          error: wdrErr.message,
        });
        return res.status(502).json({
          error: "payment_gateway_error",
          message:
            "Withdrawal to MoMo failed. Your wallet balance has been restored. Please try again.",
        });
      }

      await db.query(
        "UPDATE wallet_transactions SET status = 'completed', campay_reference = $1 WHERE id = $2",
        [campayRef, txId],
      );

      return res.json({
        transaction_id: txId,
        reference: campayRef,
        user_ref,
        amount_withdrawn: amount,
        amount_sent_to_campay: campayAmount,
        campay_fee_covered: campayFee,
        new_balance: newBalance,
        currency: "XAF",
        status: "success",
      });
    } catch (err) {
      logger.error("Wallet withdraw failed", { error: err.message });
      return res.status(500).json({
        error: "server_error",
        message: "An unexpected error occurred.",
      });
    }
  },
);

// ─── POST /v1/wallet/pay ──────────────────────────────────────────────────────
//
// Funds an existing 'pending' escrow invoice from wallet balance.
// Deducts the invoice amount from the user's wallet and marks the invoice 'paid'.
// Normal escrow rules apply on release: Fonlok deducts 2% + Campay ~1% on payout.
//
// After calling this endpoint:
//   - Buyer receives an email with a one-time release link
//   - Seller is notified when buyer releases via the normal payout flow
router.post(
  "/wallet/pay",
  [
    body("invoice_id").trim().notEmpty().withMessage("invoice_id is required."),
    body("user_ref").trim().notEmpty().withMessage("user_ref is required."),
  ],
  validate,
  async (req, res) => {
    const platformUserId = req.apiKey.user_id;
    const { invoice_id, user_ref } = req.body;

    try {
      // Look up pending invoice belonging to this platform
      const invRes = await db.query(
        `SELECT id, invoicenumber, invoicename, amount, currency,
                clientemail, seller_name, seller_email, seller_phone, userid
         FROM invoices
         WHERE invoicenumber = $1
           AND userid        = $2
           AND status        = 'pending'
           AND created_via_api = true`,
        [invoice_id, platformUserId],
      );
      if (invRes.rows.length === 0) {
        const check = await db.query(
          "SELECT status FROM invoices WHERE invoicenumber = $1 AND userid = $2 AND created_via_api = true",
          [invoice_id, platformUserId],
        );
        if (check.rows.length === 0) {
          return res.status(404).json({
            error: "invoice_not_found",
            message: `No API invoice found with id '${invoice_id}'.`,
          });
        }
        return res.status(409).json({
          error: "invalid_invoice_status",
          message: `Invoice is '${check.rows[0].status}'. Only 'pending' invoices can be funded.`,
        });
      }

      const inv = invRes.rows[0];
      const invoiceAmount = parseInt(inv.amount);

      // Atomic debit — prevents overdraft
      const debitRes = await db.query(
        `UPDATE wallets
         SET balance = balance - $1
         WHERE platform_user_id = $2 AND user_ref = $3 AND balance >= $1
         RETURNING id, balance`,
        [invoiceAmount, platformUserId, user_ref],
      );
      if (debitRes.rows.length === 0) {
        const check = await db.query(
          "SELECT balance FROM wallets WHERE platform_user_id = $1 AND user_ref = $2",
          [platformUserId, user_ref],
        );
        if (check.rows.length === 0) {
          return res.status(404).json({
            error: "wallet_not_found",
            message: `No wallet found for user_ref '${user_ref}'.`,
          });
        }
        return res.status(409).json({
          error: "insufficient_funds",
          message: `Wallet balance (${check.rows[0].balance} XAF) is less than invoice amount (${invoiceAmount} XAF).`,
          current_balance: check.rows[0].balance,
          invoice_amount: invoiceAmount,
        });
      }

      const walletId = debitRes.rows[0].id;
      const newBalance = debitRes.rows[0].balance;

      // Record wallet transaction (no fee at this stage)
      await db.query(
        `INSERT INTO wallet_transactions
           (wallet_id, type, gross_amount, net_amount, fee_amount, status, description)
         VALUES ($1, 'escrow_pay', $2, $2, 0, 'completed', $3)`,
        [
          walletId,
          invoiceAmount,
          `Escrow payment for invoice ${inv.invoicenumber}`,
        ],
      );

      // Mark invoice as paid
      await db.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [
        inv.id,
      ]);

      // Create buyer release confirmation code (same schema as paymentWebhook.js)
      const releaseCode = generate8CharCode();
      const verificationToken = crypto.randomBytes(32).toString("hex");
      await db.query(
        `INSERT INTO confirmation_codes
           (code, code_id, verification_token, userid, invoiceid)
         VALUES ($1, $2, $3, $4, $5)`,
        [releaseCode, inv.id, verificationToken, platformUserId, inv.id],
      );

      // Store buyer in guests table so the payout flow can send them emails
      if (inv.clientemail) {
        await db
          .query(
            `INSERT INTO guests (email, momo_number, invoicenumber)
             VALUES ($1, NULL, $2)
             ON CONFLICT (email, invoicenumber) DO NOTHING`,
            [inv.clientemail, inv.invoicenumber],
          )
          .catch(() => {});
      }

      // Generate chat token, store it on the guest row, and create the chat room
      const chatToken = crypto.randomBytes(32).toString("hex");
      await db
        .query(
          "UPDATE guests SET chat_token = $1 WHERE invoicenumber = $2",
          [chatToken, inv.invoicenumber],
        )
        .catch(() => {});
      await db
        .query(
          "INSERT INTO chats (invoiceid, invoicenumber) VALUES ($1, $2) ON CONFLICT (invoicenumber) DO NOTHING",
          [inv.id, inv.invoicenumber],
        )
        .catch(() => {});

      // Send branded buyer confirmation email with PDF receipt and release link (non-fatal)
      const releaseLink = `${process.env.BACKEND_URL}/api/verify-payout/${verificationToken}/${inv.id}`;
      if (inv.clientemail) {
        try {
          const confirmedCopy = buildEmailCopy("en", "paymentConfirmed");
          const receiptDownloadLink = `${process.env.BACKEND_URL}/invoice/receipt/${inv.invoicenumber}`;

          // Generate PDF receipt attachment (non-fatal if it fails)
          let buyerPdfAttachment = null;
          try {
            const pdfBuf = await generateReceiptPdf(inv.invoicenumber, "en");
            buyerPdfAttachment = {
              content: pdfBuf.toString("base64"),
              filename: `fonlok-receipt-${inv.invoicenumber}.pdf`,
              type: "application/pdf",
              disposition: "attachment",
            };
          } catch (pdfErr) {
            logger.warn("Wallet escrow buyer PDF gen failed (non-fatal)", {
              error: pdfErr.message,
            });
          }

          await sgMail.send({
            to: inv.clientemail,
            from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
            subject: confirmedCopy.subject(inv.invoicenumber),
            html: emailWrap(
              `<h2 style="color:#0F1F3D;margin:0 0 12px;">${confirmedCopy.simpleTitle}</h2>
              <p style="color:#475569;">${confirmedCopy.simpleBody}</p>
              ${emailTable([
                ["Invoice", inv.invoicenumber],
                ["Item", inv.invoicename],
                ["Amount", `${invoiceAmount} XAF`],
                ["Status", "&#10003;&nbsp;Paid &mdash; Held in Escrow"],
              ])}
              <p style="color:#475569;margin-top:12px;">${confirmedCopy.receiptMessage}</p>
              ${emailButton(receiptDownloadLink, confirmedCopy.downloadButton)}
              <p style="color:#475569;margin-top:16px;">When you are satisfied with your purchase, click the button below to release the funds to the seller.</p>
              ${emailButton(releaseLink, confirmedCopy.confirmButton)}`,
              {
                footerNote:
                  "Your funds are held securely in escrow. Only release when satisfied. Do not share this link.",
              },
            ),
            ...(buyerPdfAttachment
              ? { attachments: [buyerPdfAttachment] }
              : {}),
          });
          logger.info("Wallet escrow buyer confirmation email sent", {
            invoiceNumber: inv.invoicenumber,
          });
        } catch (emailErr) {
          logger.warn("Wallet escrow buyer email failed", {
            error: emailErr.message,
          });
        }
      }

      // Send chat invite email with chat + dispute links (non-fatal)
      if (inv.clientemail) {
        try {
          const buyerChatLink    = `${process.env.FRONTEND_URL}/chat/${inv.invoicenumber}?token=${chatToken}`;
          const buyerDisputeLink = `${process.env.FRONTEND_URL}/chat/${inv.invoicenumber}?token=${chatToken}&dispute=true`;
          const chatCopy = buildEmailCopy("en", "chatInvite");
          await sgMail.send({
            to: inv.clientemail,
            from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
            subject: chatCopy.subject(inv.invoicenumber),
            html: emailWrap(
              `<h2 style="color:#0F1F3D;margin:0 0 12px;">${chatCopy.title}</h2>
              <p style="color:#475569;">${chatCopy.body(inv.invoicenumber)}</p>
              ${emailButton(buyerChatLink, chatCopy.chatButton)}
              <h3 style="color:#0F1F3D;margin:20px 0 8px;">${chatCopy.problemTitle}</h3>
              <p style="color:#475569;">${chatCopy.problemBody}</p>
              ${emailButtonDanger(buyerDisputeLink, chatCopy.disputeButton)}`,
              { footerNote: chatCopy.footerNote },
            ),
          });
          logger.info("Wallet escrow chat invite email sent", {
            invoiceNumber: inv.invoicenumber,
          });
        } catch (chatEmailErr) {
          logger.warn("Wallet escrow chat invite email failed", {
            error: chatEmailErr.message,
          });
        }
      }

      return res.json({
        invoice_id: inv.invoicenumber,
        invoice_name: inv.invoicename,
        amount_paid: invoiceAmount,
        new_balance: newBalance,
        currency: "XAF",
        status: "funded",
        release_code: releaseCode,
        message:
          "Invoice funded from wallet and held in escrow. Buyer will receive a release link by email.",
      });
    } catch (err) {
      logger.error("Wallet pay failed", { error: err.message });
      return res.status(500).json({
        error: "server_error",
        message: "An unexpected error occurred.",
      });
    }
  },
);

export default router;
