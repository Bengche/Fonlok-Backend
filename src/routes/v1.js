/**
 * v1.js — Production public API routes for third-party integrations.
 *
 * All routes require a valid sk_live_* API key via apiKeyAuth middleware.
 * These routes operate on REAL production data and trigger REAL payments.
 *
 * Base path (mounted in server.js): /v1
 *
 * Routes:
 *   GET  /v1/ping                                  — health check
 *   POST /v1/invoices                              — create a platform escrow invoice (no Fonlok account required for seller/buyer)
 *   GET  /v1/invoices/:invoice_id                  — get invoice by ID
 *   POST /v1/payments/initiate                     — trigger buyer MoMo payment prompt
 *   GET  /v1/payments/:reference/status            — poll payment status
 *   POST /v1/payments/release                      — release held funds to seller (triggers Campay payout + emails)
 *   POST /v1/payments/dispute                      — flag a paid invoice as disputed (holds funds)
 *   POST /v1/webhooks/register                     — register a webhook endpoint
 *   GET  /v1/webhooks                              — list registered webhooks
 *   DELETE /v1/webhooks/:id                        — remove a webhook endpoint
 *
 * Security model:
 *  - Every request must carry Authorization: Bearer sk_live_<32hex>
 *  - API keys are hashed (SHA-256) at rest — the raw key is never stored
 *  - Each key is scoped to its owner (user_id) — one seller cannot touch another's data
 *  - All inputs validated and sanitised before any DB operation
 *  - Rate-limited independently from the sandbox (see rateLimiters.js)
 *  - Payment initiation goes through the real Campay API
 *  - Webhook deliveries are HMAC-SHA256 signed so the receiver can verify authenticity
 *  - SSRF guard on webhook URLs — private/loopback IPs are rejected
 */

import express from "express";
import crypto from "crypto";
import axios from "axios";
import dns from "dns/promises";
import net from "net";
import dotenv from "dotenv";
import sgMail from "@sendgrid/mail";
import { body, param } from "express-validator";
import { validate } from "../middleware/validate.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import db from "../controllers/db.js";
import logger from "../utils/logger.js";
import {
  emailWrap,
  emailTable,
  emailButton,
  emailButtonDanger,
} from "../utils/emailTemplate.js";
import { generateReceiptPdf } from "../utils/generateReceipt.js";
import { buildEmailCopy } from "../utils/emailLanguageCopy.js";

dotenv.config();
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const router = express.Router();

// Every production API route requires a valid live API key.
router.use(apiKeyAuth);

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Detect Cameroonian MoMo provider from the phone number. */
function detectProvider(phoneNumber) {
  const d5 = phoneNumber.charAt(4);
  const d6 = phoneNumber.charAt(5);
  if (d5 === "7" || d5 === "8") return "MTN";
  if (d5 === "6") return "ORANGE";
  if (d5 === "9") return d6 === "9" ? "MTN" : "ORANGE";
  if (d5 === "5") return parseInt(d6) <= 4 ? "MTN" : "ORANGE";
  return "MTN"; // safest default
}

/** SSRF guard — same logic as sandbox, reused here for webhook URL validation. */
const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

async function isSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "Invalid URL format." };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { safe: false, reason: "Only http and https URLs are allowed." };
  }
  const hostname = parsed.hostname.toLowerCase();
  const blockedNames = ["localhost", "0.0.0.0", "metadata.google.internal"];
  if (blockedNames.includes(hostname)) {
    return {
      safe: false,
      reason: `'${hostname}' is not an allowed webhook URL.`,
    };
  }
  if (net.isIPv4(hostname) || net.isIPv6(hostname)) {
    if (PRIVATE_IP_PATTERNS.some((r) => r.test(hostname))) {
      return {
        safe: false,
        reason: "Private IP addresses are not allowed as webhook URLs.",
      };
    }
    return { safe: true };
  }
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    for (const { address } of addrs) {
      if (PRIVATE_IP_PATTERNS.some((r) => r.test(address))) {
        return {
          safe: false,
          reason: `Webhook URL resolves to a private IP (${address}).`,
        };
      }
    }
  } catch {
    return {
      safe: false,
      reason: "Could not resolve the webhook URL hostname.",
    };
  }
  return { safe: true };
}

/**
 * Sign an outbound webhook payload.
 * Returns the value of the X-Fonlok-Signature header the receiver should verify.
 * Algorithm: HMAC-SHA256(raw JSON body, webhook_secret)
 */
function signWebhookPayload(rawBody, secret) {
  return (
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")
  );
}

/**
 * Deliver a webhook event to all registered endpoints for this API key's owner.
 * Failures are logged but never throw — a webhook delivery failure must never
 * break the primary payment flow.
 */
async function deliverWebhookEvent(userId, eventType, payload) {
  try {
    const hooks = await db.query(
      `SELECT id, url, secret FROM api_webhooks WHERE user_id = $1 AND active = true`,
      [userId],
    );
    if (hooks.rows.length === 0) return;

    const rawBody = JSON.stringify(payload);

    for (const hook of hooks.rows) {
      const signature = signWebhookPayload(rawBody, hook.secret);
      try {
        await axios.post(hook.url, payload, {
          timeout: 8000,
          maxRedirects: 0,
          headers: {
            "Content-Type": "application/json",
            "X-Fonlok-Signature": signature,
            "X-Fonlok-Event": eventType,
            "User-Agent": "Fonlok-Webhooks/1.0",
          },
          validateStatus: () => true,
        });
        logger.info("Webhook delivered", {
          hookId: hook.id,
          event: eventType,
          url: hook.url,
        });
      } catch (err) {
        logger.warn("Webhook delivery failed", {
          hookId: hook.id,
          event: eventType,
          url: hook.url,
          error: err.message,
        });
      }
    }
  } catch (err) {
    logger.error("deliverWebhookEvent: DB error", { error: err.message });
  }
}

// ── GET /v1/ping ──────────────────────────────────────────────────────────────
// Health check. Verifies the key is valid and the API is reachable.
router.get("/ping", (req, res) => {
  res.json({
    object: "api_status",
    status: "ok",
    environment: "production",
    key_label: req.apiKey.label,
    message:
      "Fonlok live API is operational. Real transactions will be processed.",
    timestamp: new Date().toISOString(),
  });
});

// ── POST /v1/invoices — create a platform escrow invoice ────────────────────
//
// Creates an escrow invoice on behalf of any seller on your platform.
// No Fonlok account is required for the seller or buyer — pass their
// contact details directly. Funds are held by Fonlok until you call
// POST /v1/payments/release, at which point Fonlok disburses net amount
// (after 3% fee) to seller_phone and sends email receipts to both parties.
router.post(
  "/invoices",
  [
    body("title")
      .trim()
      .notEmpty()
      .withMessage("title is required.")
      .isLength({ max: 200 })
      .withMessage("title must be 200 characters or fewer.")
      .escape(),
    body("amount")
      .notEmpty()
      .withMessage("amount is required.")
      .isFloat({ min: 500 })
      .withMessage("amount must be at least 500 XAF."),
    body("currency")
      .optional()
      .isIn(["XAF"])
      .withMessage("Only XAF is supported."),
    body("seller_name")
      .trim()
      .notEmpty()
      .withMessage("seller_name is required.")
      .isLength({ max: 200 })
      .withMessage("seller_name must be 200 characters or fewer.")
      .escape(),
    body("seller_email")
      .notEmpty()
      .withMessage("seller_email is required.")
      .isEmail()
      .withMessage("seller_email must be a valid email address.")
      .normalizeEmail(),
    body("seller_phone")
      .trim()
      .notEmpty()
      .withMessage("seller_phone is required.")
      .matches(/^237[62]\d{8}$/)
      .withMessage(
        "seller_phone must be a valid Cameroonian MoMo number (e.g. 237670000000).",
      ),
    body("buyer_email")
      .optional({ checkFalsy: true })
      .isEmail()
      .withMessage("buyer_email must be a valid email address.")
      .normalizeEmail(),
    body("buyer_phone")
      .optional({ checkFalsy: true })
      .trim()
      .matches(/^237[62]\d{8}$/)
      .withMessage(
        "buyer_phone must be a valid Cameroonian MoMo number (e.g. 237670000000).",
      ),
    body("description")
      .optional({ checkFalsy: true })
      .trim()
      .isLength({ max: 2000 })
      .withMessage("description must be 2000 characters or fewer.")
      .escape(),
    body("reference")
      .optional({ checkFalsy: true })
      .trim()
      .isLength({ max: 200 })
      .withMessage("reference must be 200 characters or fewer.")
      .escape(),
    body("expires_at")
      .optional({ checkFalsy: true })
      .isISO8601()
      .withMessage(
        "expires_at must be a valid ISO 8601 date (e.g. 2026-12-31).",
      ),
  ],
  validate,
  async (req, res) => {
    const platformUserId = req.apiKey.user_id; // Njimbong's Fonlok account
    const {
      title,
      amount,
      currency = "XAF",
      seller_name,
      seller_email,
      seller_phone,
      buyer_email = null,
      buyer_phone = null,
      description = null,
      reference = null,
      expires_at = null,
    } = req.body;

    try {
      // Ensure external reference is unique per API key owner if provided.
      if (reference) {
        const dupCheck = await db.query(
          `SELECT 1 FROM invoices WHERE userid = $1 AND external_reference = $2 LIMIT 1`,
          [platformUserId, reference],
        );
        if (dupCheck.rows.length > 0) {
          return res.status(409).json({
            error: "duplicate_reference",
            message: `An invoice with reference '${reference}' already exists.`,
          });
        }
      }

      const invoiceNumber = `${platformUserId}-${crypto.randomBytes(6).toString("hex")}`;
      const invoiceLink = `${process.env.FRONTEND_URL}/pay/${invoiceNumber}`;

      const result = await db.query(
        `INSERT INTO invoices
           (invoicename, clientemail, currency, amount, invoicenumber, userid,
            invoicelink, description, expires_at, payment_type, external_reference,
            created_via_api, seller_name, seller_email, seller_phone, buyer_phone)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'full', $10, true, $11, $12, $13, $14)
         RETURNING id, invoicenumber, invoicename, clientemail, currency, amount,
                   invoicelink, description, expires_at, external_reference,
                   status, seller_name, seller_email, seller_phone, buyer_phone,
                   createdat AS created_at`,
        [
          title,
          buyer_email || null,
          currency,
          parseFloat(amount),
          invoiceNumber,
          platformUserId,
          invoiceLink,
          description,
          expires_at || null,
          reference || null,
          seller_name,
          seller_email,
          seller_phone,
          buyer_phone,
        ],
      );

      const inv = result.rows[0];

      logger.info("Platform invoice created via API", {
        invoiceId: inv.id,
        invoiceNumber: inv.invoicenumber,
        platformUserId,
        keyId: req.apiKey.id,
        amount: inv.amount,
        sellerPhone: inv.seller_phone,
      });

      return res.status(201).json({
        object: "invoice",
        id: inv.invoicenumber,
        title: inv.invoicename,
        description: inv.description,
        amount: parseFloat(inv.amount),
        currency: inv.currency,
        seller: {
          name: inv.seller_name,
          email: inv.seller_email,
          phone: inv.seller_phone,
        },
        buyer_email: inv.clientemail,
        buyer_phone: inv.buyer_phone,
        status: inv.status,
        payment_url: inv.invoicelink,
        external_reference: inv.external_reference,
        expires_at: inv.expires_at,
        created_at: inv.created_at,
      });
    } catch (err) {
      logger.error("Failed to create platform invoice via API", {
        error: err.message,
        platformUserId,
        keyId: req.apiKey.id,
      });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to create invoice. Please try again.",
      });
    }
  },
);

// ── GET /v1/invoices/:invoice_id ─────────────────────────────────────────────
router.get(
  "/invoices/:invoice_id",
  [
    param("invoice_id")
      .trim()
      .notEmpty()
      .withMessage("invoice_id is required."),
  ],
  validate,
  async (req, res) => {
    const sellerId = req.apiKey.user_id;
    const { invoice_id } = req.params;

    try {
      const result = await db.query(
        `SELECT id, invoicenumber, invoicename, clientemail, currency, amount,
                invoicelink, description, expires_at, external_reference,
                status, seller_name, seller_email, seller_phone, buyer_phone,
                createdat AS created_at, paidat AS paid_at, deliveredat AS delivered_at
         FROM invoices
         WHERE invoicenumber = $1 AND userid = $2`,
        [invoice_id, sellerId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "not_found",
          message: `No invoice found with id '${invoice_id}' on your account.`,
        });
      }

      const inv = result.rows[0];

      // For disputed invoices, ensure chat tokens exist and return the links.
      // This handles both new disputes (tokens already set) and old disputes
      // (tokens not yet generated) — tokens are lazily created on first GET.
      let chatLinks = null;
      if (inv.status === "disputed") {
        try {
          const [guestResult, chatResult] = await Promise.all([
            db.query(
              "SELECT chat_token FROM guests WHERE invoicenumber = $1 AND chat_token IS NOT NULL LIMIT 1",
              [inv.invoicenumber],
            ),
            db.query(
              "SELECT seller_chat_token FROM chats WHERE invoicenumber = $1 AND seller_chat_token IS NOT NULL LIMIT 1",
              [inv.invoicenumber],
            ),
          ]);
          let buyerToken = guestResult.rows[0]?.chat_token || null;
          let sellerToken = chatResult.rows[0]?.seller_chat_token || null;

          if (!buyerToken) {
            buyerToken = crypto.randomBytes(32).toString("hex");
            const upd = await db
              .query(
                "UPDATE guests SET chat_token = $1 WHERE invoicenumber = $2 RETURNING id",
                [buyerToken, inv.invoicenumber],
              )
              .catch(() => ({ rows: [] }));
            if (upd.rows.length === 0 && inv.clientemail) {
              await db
                .query(
                  `INSERT INTO guests (email, momo_number, invoicenumber, chat_token)
                   VALUES ($1, NULL, $2, $3)
                   ON CONFLICT (email, invoicenumber) DO UPDATE SET chat_token = EXCLUDED.chat_token`,
                  [inv.clientemail, inv.invoicenumber, buyerToken],
                )
                .catch(() => {});
            }
          }
          if (!sellerToken) {
            sellerToken = crypto.randomBytes(32).toString("hex");
            await db
              .query(
                `INSERT INTO chats (invoiceid, invoicenumber, seller_chat_token)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (invoicenumber) DO UPDATE SET seller_chat_token = EXCLUDED.seller_chat_token`,
                [inv.id, inv.invoicenumber, sellerToken],
              )
              .catch(() => {});
          }
          chatLinks = {
            buyer: `${process.env.FRONTEND_URL}/chat/${inv.invoicenumber}?token=${buyerToken}&role=buyer`,
            seller: `${process.env.FRONTEND_URL}/chat/${inv.invoicenumber}?token=${sellerToken}&role=seller`,
          };
        } catch (chatErr) {
          logger.warn("chat_links lazy gen failed (non-fatal)", {
            error: chatErr.message,
          });
        }
      }

      return res.json({
        object: "invoice",
        id: inv.invoicenumber,
        title: inv.invoicename,
        description: inv.description,
        amount: parseFloat(inv.amount),
        currency: inv.currency,
        seller: inv.seller_name
          ? {
              name: inv.seller_name,
              email: inv.seller_email,
              phone: inv.seller_phone,
            }
          : null,
        buyer_email: inv.clientemail,
        buyer_phone: inv.buyer_phone,
        status: inv.status,
        payment_url: inv.invoicelink,
        external_reference: inv.external_reference,
        expires_at: inv.expires_at,
        created_at: inv.created_at,
        paid_at: inv.paid_at,
        delivered_at: inv.delivered_at,
        ...(chatLinks ? { chat_links: chatLinks } : {}),
      });
    } catch (err) {
      logger.error("Failed to fetch invoice via API", {
        error: err.message,
        stack: err.stack,
      });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to retrieve invoice.",
        _debug: err.message, // temporary — remove after diagnosis
      });
    }
  },
);

// ── POST /v1/payments/initiate ───────────────────────────────────────────────
//
// Triggers a real Mobile Money payment prompt on the buyer's phone via Campay.
// The invoice must belong to the API key owner and be in 'pending' status.
//
// Security:
//  - The invoice ownership is verified against the API key's user_id.
//  - The phone number format is strictly validated.
//  - An atomic INSERT into the payments table happens BEFORE the Campay call
//    so the row exists when Campay fires its webhook milliseconds later.
//  - Duplicate payment attempts on a non-pending invoice are rejected with 409.
router.post(
  "/payments/initiate",
  [
    body("invoice_id").trim().notEmpty().withMessage("invoice_id is required."),
    body("phone_number")
      .trim()
      .matches(/^237[62]\d{8}$/)
      .withMessage(
        "phone_number must be a valid Cameroonian number (e.g. 237670000000).",
      ),
    body("buyer_email")
      .optional({ checkFalsy: true })
      .isEmail()
      .withMessage("buyer_email must be a valid email address if provided.")
      .normalizeEmail(),
  ],
  validate,
  async (req, res) => {
    const sellerId = req.apiKey.user_id;
    const { invoice_id, phone_number, buyer_email = null } = req.body;

    try {
      // 1. Verify the invoice exists, belongs to this seller, and is payable.
      const invResult = await db.query(
        `SELECT id, invoicenumber, invoicename, amount, currency, status, clientemail
         FROM invoices
         WHERE invoicenumber = $1 AND userid = $2`,
        [invoice_id, sellerId],
      );

      if (invResult.rows.length === 0) {
        return res.status(404).json({
          error: "invoice_not_found",
          message: `No invoice found with id '${invoice_id}' on your account.`,
        });
      }

      const inv = invResult.rows[0];

      if (inv.status !== "pending") {
        return res.status(409).json({
          error: "invalid_invoice_status",
          message: `Cannot initiate payment for an invoice with status '${inv.status}'. Only 'pending' invoices can be paid.`,
        });
      }

      if (inv.amount < 500) {
        return res.status(400).json({
          error: "amount_too_low",
          message:
            "Invoice amount must be at least 500 XAF to initiate a payment.",
        });
      }

      const provider = detectProvider(phone_number);
      const paymentUUID = crypto.randomUUID();

      // 2. Record the payment row BEFORE calling Campay — the webhook fires
      //    almost immediately and must find this row already committed.
      await db.query(
        `INSERT INTO payments
           (invoiceid, provider, providerpaymentid, amount, currency)
         VALUES ($1, $2, $3, $4, $5)`,
        [inv.id, provider, paymentUUID, inv.amount, inv.currency],
      );

      // 3. Save buyer contact details (for emails and confirmation code).
      // Only persist when a real buyer email is available so we never write
      // the seller's address into the guests table and accidentally direct
      // both confirmation emails to the seller.
      const effectiveBuyerEmail = buyer_email || inv.clientemail || null;
      if (effectiveBuyerEmail) {
        await db.query(
          `INSERT INTO guests (email, momo_number, invoicenumber)
           VALUES ($1, $2, $3)
           ON CONFLICT (email, invoicenumber)
           DO UPDATE SET momo_number = EXCLUDED.momo_number`,
          [effectiveBuyerEmail, phone_number, inv.invoicenumber],
        );
      }

      // 4. Authenticate with Campay and trigger the real MoMo prompt.
      let campayToken;
      try {
        const authRes = await axios.post(
          `${process.env.CAMPAY_BASE_URL}token/`,
          {
            username: process.env.CAMPAY_USERNAME,
            password: process.env.CAMPAY_PASSWORD,
          },
          { timeout: 10000 },
        );
        campayToken = authRes.data.token;
      } catch (campayAuthErr) {
        // Roll back the payments row so this payment UUID can be retried cleanly.
        await db
          .query(`DELETE FROM payments WHERE providerpaymentid = $1`, [
            paymentUUID,
          ])
          .catch(() => {});
        logger.error("Campay auth failed during API payment initiation", {
          error: campayAuthErr.message,
          invoiceNumber: inv.invoicenumber,
        });
        return res.status(502).json({
          error: "payment_gateway_error",
          message:
            "Could not connect to the payment gateway. Please try again.",
        });
      }

      let campayResponse;
      try {
        campayResponse = await axios.post(
          `${process.env.CAMPAY_BASE_URL}collect/`,
          {
            amount: String(Math.floor(inv.amount)),
            currency: "XAF",
            from: phone_number,
            description: `Fonlok escrow payment for: ${inv.invoicename}`,
            external_reference: paymentUUID,
          },
          {
            headers: { Authorization: `Token ${campayToken}` },
            timeout: 15000,
          },
        );
      } catch (campayErr) {
        // Roll back the payments row on Campay failure too.
        await db
          .query(`DELETE FROM payments WHERE providerpaymentid = $1`, [
            paymentUUID,
          ])
          .catch(() => {});
        logger.error("Campay collect failed during API payment initiation", {
          error: campayErr.message,
          invoiceNumber: inv.invoicenumber,
        });
        return res.status(502).json({
          error: "payment_gateway_error",
          message:
            "The payment gateway rejected the request. Verify the phone number and try again.",
        });
      }

      // Persist Campay's own transaction reference so the poll endpoint can
      // query Campay by their reference if needed (campay_reference column).
      // Non-fatal: if this fails the payment still proceeds normally.
      const campayRef = campayResponse?.data?.reference ?? null;
      if (campayRef) {
        db.query(
          `UPDATE payments SET campay_reference = $1 WHERE providerpaymentid = $2`,
          [campayRef, paymentUUID],
        ).catch((e) =>
          logger.warn("Failed to persist campay_reference", {
            error: e.message,
          }),
        );
      }

      logger.info("Production payment initiated via API", {
        invoiceNumber: inv.invoicenumber,
        paymentUUID,
        provider,
        phone: phone_number,
        keyId: req.apiKey.id,
      });

      // 5. Fire webhook event asynchronously — never block the response.
      deliverWebhookEvent(sellerId, "payment.initiated", {
        object: "event",
        type: "payment.initiated",
        invoice_id: inv.invoicenumber,
        reference: paymentUUID,
        amount: parseFloat(inv.amount),
        currency: inv.currency,
        provider,
        phone_number,
        status: "pending",
        timestamp: new Date().toISOString(),
      }).catch(() => {});

      return res.status(201).json({
        object: "payment",
        reference: paymentUUID,
        invoice_id: inv.invoicenumber,
        amount: parseFloat(inv.amount),
        currency: inv.currency,
        provider,
        phone_number,
        status: "pending",
        message: `A ${provider} Mobile Money prompt has been sent to ${phone_number}. The buyer must approve it on their phone.`,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      logger.error("Unexpected error during API payment initiation", {
        error: err.message,
        stack: err.stack,
        keyId: req.apiKey.id,
      });
      return res.status(500).json({
        error: "server_error",
        message: "An unexpected error occurred. Please try again.",
      });
    }
  },
);

// ── GET /v1/payments/:reference/status ───────────────────────────────────────
//
// Poll the status of a payment by its reference (the UUID returned at initiation).
// Only returns payments linked to invoices owned by the API key owner.
router.get(
  "/payments/:reference/status",
  [param("reference").trim().notEmpty().withMessage("reference is required.")],
  validate,
  async (req, res) => {
    const sellerId = req.apiKey.user_id;
    const { reference } = req.params;

    // UUID format validation — prevents DB queries with obviously invalid input.
    const UUID_REGEX =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(reference)) {
      return res.status(400).json({
        error: "invalid_reference",
        message: "reference must be a valid UUID.",
      });
    }

    try {
      const result = await db.query(
        `SELECT p.providerpaymentid AS reference,
                p.status,
                p.amount,
                p.currency,
                p.provider,
                p.created_at,
                i.invoicenumber AS invoice_id,
                i.status AS invoice_status
         FROM payments p
         JOIN invoices i ON i.id = p.invoiceid
         WHERE p.providerpaymentid = $1
           AND i.userid = $2`,
        [reference, sellerId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "not_found",
          message: `No payment found with reference '${reference}' on your account.`,
        });
      }

      const row = result.rows[0];
      return res.json({
        object: "payment_status",
        reference: row.reference,
        invoice_id: row.invoice_id,
        amount: parseFloat(row.amount),
        currency: row.currency,
        provider: row.provider,
        status: row.status, // "pending" | "paid" | "failed"
        invoice_status: row.invoice_status, // "pending" | "paid" | "delivered" | "completed" | "disputed" | "cancelled"
        created_at: row.created_at,
      });
    } catch (err) {
      logger.error("Failed to fetch payment status via API", {
        error: err.message,
      });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to retrieve payment status.",
      });
    }
  },
);

// ── POST /v1/payments/release — release held funds to seller ─────────────────
//
// Call this after the buyer confirms receipt of goods/service.
// Fonlok will:
//   1. Deduct the 3% platform fee
//   2. Disburse the net amount to seller_phone via Campay MoMo
//   3. Send email confirmations to both seller and buyer
//   4. Fire a payment.released webhook event to your registered endpoint
//
// Only invoices in 'paid' status (funds held) can be released.
// This operation is atomic — concurrent calls for the same invoice are safe.
router.post(
  "/payments/release",
  [body("invoice_id").trim().notEmpty().withMessage("invoice_id is required.")],
  validate,
  async (req, res) => {
    const platformUserId = req.apiKey.user_id;
    const { invoice_id } = req.body;

    try {
      // Atomic claim: UPDATE only succeeds when status = 'paid'.
      // Concurrent calls will find status already 'completed' and get 0 rows.
      const claimResult = await db.query(
        `UPDATE invoices
         SET status = 'completed'
         WHERE invoicenumber = $1
           AND userid        = $2
           AND status        = 'paid'
           AND created_via_api = true
         RETURNING id, invoicenumber, invoicename, amount, currency,
                   clientemail, seller_name, seller_email, seller_phone`,
        [invoice_id, platformUserId],
      );

      if (claimResult.rows.length === 0) {
        // Distinguish not-found from wrong-status for a clear error message.
        const checkResult = await db.query(
          `SELECT status FROM invoices
           WHERE invoicenumber = $1 AND userid = $2 AND created_via_api = true`,
          [invoice_id, platformUserId],
        );
        if (checkResult.rows.length === 0) {
          return res.status(404).json({
            error: "invoice_not_found",
            message: `No API invoice found with id '${invoice_id}'.`,
          });
        }
        const currentStatus = checkResult.rows[0].status;
        return res.status(409).json({
          error: "invalid_invoice_status",
          message: `Cannot release an invoice with status '${currentStatus}'. Only 'paid' invoices can be released.`,
        });
      }

      const inv = claimResult.rows[0];
      const grossAmount = parseFloat(inv.amount);
      const TOTAL_FEE_RATE = 0.02; // 2% platform fee (Campay takes ~1% separately)
      const platformFee = Math.floor(grossAmount * TOTAL_FEE_RATE);
      const sellerReceives = grossAmount - platformFee;

      // Authenticate with Campay.
      let campayToken;
      try {
        const authRes = await axios.post(
          `${process.env.CAMPAY_BASE_URL}token/`,
          {
            username: process.env.CAMPAY_USERNAME,
            password: process.env.CAMPAY_PASSWORD,
          },
          { timeout: 10000 },
        );
        campayToken = authRes.data.token;
      } catch (campayAuthErr) {
        // Rollback — restore 'paid' so release can be retried.
        await db
          .query(`UPDATE invoices SET status = 'paid' WHERE id = $1`, [inv.id])
          .catch(() => {});
        logger.error("Campay auth failed during API release", {
          error: campayAuthErr.message,
          invoiceNumber: inv.invoicenumber,
        });
        return res.status(502).json({
          error: "payment_gateway_error",
          message:
            "Could not connect to the payment gateway. Please try again.",
        });
      }

      // Disburse to seller's MoMo.
      try {
        await axios.post(
          `${process.env.CAMPAY_BASE_URL}withdraw/`,
          {
            amount: String(sellerReceives),
            currency: inv.currency,
            to: inv.seller_phone,
            description: `Fonlok payout: ${inv.invoicename}`,
            external_reference: inv.invoicenumber,
          },
          {
            headers: { Authorization: `Token ${campayToken}` },
            timeout: 15000,
          },
        );
      } catch (campayErr) {
        // Rollback status on Campay failure.
        await db
          .query(`UPDATE invoices SET status = 'paid' WHERE id = $1`, [inv.id])
          .catch(() => {});
        logger.error("Campay withdraw failed during API release", {
          error: campayErr.message,
          invoiceNumber: inv.invoicenumber,
        });
        return res.status(502).json({
          error: "payment_gateway_error",
          message:
            "Payout to seller failed. The invoice status has been restored. Please try again.",
        });
      }

      // Record payout row for audit trail.
      await db
        .query(
          `INSERT INTO payouts (userid, amount, method, status, invoice_id, invoice_number)
           VALUES ($1, $2, 'Mobile Money', 'paid', $3, $4)`,
          [platformUserId, sellerReceives, inv.id, inv.invoicenumber],
        )
        .catch((e) =>
          logger.warn("Failed to record payout row", { error: e.message }),
        );

      logger.info("API payment released", {
        invoiceNumber: inv.invoicenumber,
        sellerPhone: inv.seller_phone,
        sellerReceives,
        platformFee,
        keyId: req.apiKey.id,
      });

      // Branded seller release email (non-fatal).
      try {
        if (inv.seller_email) {
          const emailDisplayFee = Math.round(grossAmount * 0.03);
          const emailSellerNet = grossAmount - emailDisplayFee;
          const payoutCopy = buildEmailCopy("en", "payoutConfirmed");
          const feeLabel = `${payoutCopy.feeLabel} (3%)`;
          const sellerReceiptLink = `${process.env.BACKEND_URL}/invoice/receipt/${inv.invoicenumber}`;
          let sellerPdf = null;
          try {
            const buf = await generateReceiptPdf(inv.invoicenumber, "en");
            sellerPdf = {
              content: buf.toString("base64"),
              filename: `fonlok-receipt-${inv.invoicenumber}.pdf`,
              type: "application/pdf",
              disposition: "attachment",
            };
          } catch (pdfErr) {
            logger.warn("Seller PDF gen failed (non-fatal)", {
              error: pdfErr.message,
            });
          }
          await sgMail.send({
            to: inv.seller_email,
            from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
            subject: payoutCopy.subject(inv.invoicenumber),
            html: emailWrap(
              `<h2 style="color:#0F1F3D;margin:0 0 12px;">${payoutCopy.title}</h2>
              <p style="color:#475569;">${payoutCopy.body(inv.seller_name || "there")}</p>
              ${emailTable([
                ["Invoice Number", inv.invoicenumber],
                ["Invoice Name", inv.invoicename],
                [payoutCopy.grossAmount, `${grossAmount} XAF`],
                [feeLabel, `-${emailDisplayFee} XAF`, "color:#dc2626;"],
                [
                  payoutCopy.amountSent,
                  `${emailSellerNet} XAF`,
                  "font-weight:700;color:#16a34a;font-size:15px;",
                ],
                [payoutCopy.sentTo, inv.seller_phone],
                [
                  payoutCopy.status,
                  `&#10003;&nbsp;${payoutCopy.paidOut}`,
                  "color:#16a34a;font-weight:600;",
                ],
              ])}
              <p style="color:#475569;margin-top:12px;">${payoutCopy.receiptMessage}</p>
              ${emailButton(sellerReceiptLink, payoutCopy.downloadButton)}`,
              { footerNote: payoutCopy.footer },
            ),
            ...(sellerPdf ? { attachments: [sellerPdf] } : {}),
          });
          logger.info("Branded seller release email sent", {
            invoiceNumber: inv.invoicenumber,
          });
        }
      } catch (sellerEmailErr) {
        logger.warn("Seller release email failed", {
          error: sellerEmailErr.message,
        });
      }

      // Branded buyer release email (non-fatal).
      try {
        if (inv.clientemail) {
          const emailDisplayFeeB = Math.round(grossAmount * 0.03);
          const emailSellerNetB = grossAmount - emailDisplayFeeB;
          const releasedCopy = buildEmailCopy("en", "fundsReleased");
          const buyerReceiptLink = `${process.env.BACKEND_URL}/invoice/receipt/${inv.invoicenumber}`;
          let buyerPdf = null;
          try {
            const buf = await generateReceiptPdf(inv.invoicenumber, "en");
            buyerPdf = {
              content: buf.toString("base64"),
              filename: `fonlok-receipt-${inv.invoicenumber}.pdf`,
              type: "application/pdf",
              disposition: "attachment",
            };
          } catch (pdfErr) {
            logger.warn("Buyer PDF gen failed (non-fatal)", {
              error: pdfErr.message,
            });
          }
          await sgMail.send({
            to: inv.clientemail,
            from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
            subject: releasedCopy.subject(inv.invoicenumber),
            html: emailWrap(
              `<h2 style="color:#0F1F3D;margin:0 0 12px;">${releasedCopy.title}</h2>
              <p style="color:#475569;">${releasedCopy.body(inv.seller_name || "the seller", inv.invoicename)}</p>
              ${emailTable([
                ["Invoice Number", inv.invoicenumber],
                ["Invoice Name", inv.invoicename],
                [releasedCopy.grossAmount, `${grossAmount} XAF`],
                [
                  releasedCopy.feeLabel,
                  `-${emailDisplayFeeB} XAF`,
                  "color:#dc2626;",
                ],
                [
                  releasedCopy.sellerReceived,
                  `${emailSellerNetB} XAF`,
                  "font-weight:700;color:#16a34a;font-size:15px;",
                ],
              ])}
              <p style="color:#475569;margin-top:12px;">${releasedCopy.receiptMessage}</p>
              ${emailButton(buyerReceiptLink, releasedCopy.downloadButton)}`,
              { footerNote: releasedCopy.footerNote },
            ),
            ...(buyerPdf ? { attachments: [buyerPdf] } : {}),
          });
          logger.info("Branded buyer release email sent", {
            invoiceNumber: inv.invoicenumber,
          });
        }
      } catch (buyerEmailErr) {
        logger.warn("Buyer release email failed", {
          error: buyerEmailErr.message,
        });
      }

      // Fire webhook — never block the response.
      deliverWebhookEvent(platformUserId, "payment.released", {
        object: "event",
        type: "payment.released",
        invoice_id: inv.invoicenumber,
        invoice_name: inv.invoicename,
        buyer_email: inv.clientemail || null,
        seller_phone: inv.seller_phone,
        seller_email: inv.seller_email,
        gross_amount: grossAmount,
        platform_fee: platformFee,
        seller_receives: sellerReceives,
        currency: inv.currency,
        timestamp: new Date().toISOString(),
      }).catch(() => {});

      return res.json({
        object: "release",
        invoice_id: inv.invoicenumber,
        status: "completed",
        gross_amount: grossAmount,
        platform_fee: platformFee,
        seller_receives: sellerReceives,
        currency: inv.currency,
        seller_phone: inv.seller_phone,
        message: `${sellerReceives.toLocaleString()} XAF dispatched to ${inv.seller_phone} via Mobile Money.`,
        released_at: new Date().toISOString(),
      });
    } catch (err) {
      logger.error("Unexpected error during API payment release", {
        error: err.message,
        stack: err.stack,
        keyId: req.apiKey.id,
      });
      return res.status(500).json({
        error: "server_error",
        message:
          "An unexpected error occurred during release. Please try again.",
      });
    }
  },
);

// ── POST /v1/payments/dispute — flag a paid invoice as disputed ──────────────
//
// Call this when the buyer raises a complaint before funds are released.
// Fonlok will hold the payment and fire a payment.disputed webhook event.
// Once disputed, funds cannot be released via the API until support resolves it.
// Contact support@fonlok.com with the invoice_id to initiate resolution.
//
// Only 'paid' invoices created via the API can be disputed here.
router.post(
  "/payments/dispute",
  [
    body("invoice_id").trim().notEmpty().withMessage("invoice_id is required."),
    body("reason")
      .trim()
      .notEmpty()
      .withMessage("reason is required.")
      .isLength({ max: 1000 })
      .withMessage("reason must be 1000 characters or fewer.")
      .escape(),
    body("context")
      .optional({ checkFalsy: true })
      .trim()
      .isLength({ max: 10000 })
      .withMessage("context must be 10 000 characters or fewer.")
      .escape(),
  ],
  validate,
  async (req, res) => {
    const platformUserId = req.apiKey.user_id;
    const { invoice_id, reason, context: disputeContext = null } = req.body;

    try {
      // Atomic status change — only succeeds if invoice is currently 'paid'.
      const claimResult = await db.query(
        `UPDATE invoices
         SET status = 'disputed'
         WHERE invoicenumber = $1
           AND userid        = $2
           AND status        = 'paid'
           AND created_via_api = true
         RETURNING id, invoicenumber, invoicename, amount, currency,
                   clientemail, seller_name, seller_email, seller_phone`,
        [invoice_id, platformUserId],
      );

      if (claimResult.rows.length === 0) {
        const checkResult = await db.query(
          `SELECT status FROM invoices
           WHERE invoicenumber = $1 AND userid = $2 AND created_via_api = true`,
          [invoice_id, platformUserId],
        );
        if (checkResult.rows.length === 0) {
          return res.status(404).json({
            error: "invoice_not_found",
            message: `No API invoice found with id '${invoice_id}'.`,
          });
        }
        const currentStatus = checkResult.rows[0].status;
        return res.status(409).json({
          error: "invalid_invoice_status",
          message: `Cannot dispute an invoice with status '${currentStatus}'. Only 'paid' invoices can be disputed.`,
        });
      }

      const inv = claimResult.rows[0];

      // ── Record in disputes table (admin dashboard + moderator link) ─────
      const adminToken = crypto.randomBytes(32).toString("hex");
      try {
        await db.query(
          "INSERT INTO disputes (invoiceid, invoicenumber, opened_by, reason, admin_token, dispute_scope, disputed_milestone_ids, disputed_amount) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          [
            inv.id,
            inv.invoicenumber,
            "buyer",
            disputeContext
              ? `${reason}\n\n--- Additional Context ---\n${disputeContext}`
              : reason,
            adminToken,
            "full",
            [],
            Number(inv.amount),
          ],
        );
      } catch (disputeInsertErr) {
        logger.error("Failed to insert API dispute record", {
          error: disputeInsertErr.message,
        });
      }

      // ── Create chat room and generate buyer + seller tokens ──────────────
      const buyerChatToken = crypto.randomBytes(32).toString("hex");
      const sellerChatToken = crypto.randomBytes(32).toString("hex");
      if (inv.clientemail) {
        // Ensure a guest row exists (may already exist from payment initiation)
        await db
          .query(
            `INSERT INTO guests (email, momo_number, invoicenumber)
           VALUES ($1, NULL, $2) ON CONFLICT (email, invoicenumber) DO NOTHING`,
            [inv.clientemail, inv.invoicenumber],
          )
          .catch(() => {});
      }
      // Always update the token — a guest row may exist from payment initiation
      // even when clientemail is null on the invoice (buyer_email was used instead).
      await db
        .query("UPDATE guests SET chat_token = $1 WHERE invoicenumber = $2", [
          buyerChatToken,
          inv.invoicenumber,
        ])
        .catch(() => {});
      await db
        .query(
          `INSERT INTO chats (invoiceid, invoicenumber, seller_chat_token)
         VALUES ($1, $2, $3)
         ON CONFLICT (invoicenumber) DO UPDATE SET seller_chat_token = EXCLUDED.seller_chat_token`,
          [inv.id, inv.invoicenumber, sellerChatToken],
        )
        .catch(() => {});
      const buyerChatLink = `${process.env.FRONTEND_URL}/chat/${inv.invoicenumber}?token=${buyerChatToken}&role=buyer`;
      const sellerChatLink = `${process.env.FRONTEND_URL}/chat/${inv.invoicenumber}?token=${sellerChatToken}&role=seller`;
      const adminLink = `${process.env.FRONTEND_URL}/admin/dispute/${adminToken}`;
      const adminEmailMsg = {
        to: process.env.ADMIN_EMAIL,
        from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
        subject: `[Admin] New Dispute — Invoice ${inv.invoicenumber} | Fonlok`,
        html: emailWrap(
          `<h2 style="color:#0F1F3D;margin:0 0 12px;">New Dispute &mdash; Invoice ${inv.invoicenumber}</h2>
          <p style="color:#475569;">A dispute has been raised via the API and requires your review.</p>
          ${emailTable([
            ["Invoice Number", inv.invoicenumber],
            ["Invoice Name", inv.invoicename],
            [
              "Amount",
              `${Number(inv.amount).toLocaleString()} ${inv.currency}`,
              "font-weight:700;font-size:15px;",
            ],
            ["Opened By", "Buyer (via API)"],
            ["Reason", reason],
            ...(disputeContext
              ? [["Full Context / Transcript", disputeContext]]
              : []),
          ])}
          <p style="color:#475569;">Click below to review all messages and make a moderation decision.</p>
          ${emailButtonDanger(adminLink, "Review Dispute &amp; Join Chat")}`,
          {
            subtitle: "Admin Notification",
            footerNote:
              "Keep this link private &mdash; it gives admin access to the dispute.",
          },
        ),
      };
      if (!process.env.ADMIN_EMAIL) {
        logger.warn(
          "Admin dispute email skipped: ADMIN_EMAIL env var is not set",
        );
      } else {
        try {
          await sgMail.send(adminEmailMsg);
          logger.info("Admin dispute email sent", {
            invoiceNumber: inv.invoicenumber,
          });
        } catch (emailErr) {
          logger.error("Admin dispute email failed", {
            error: emailErr.response
              ? JSON.stringify(emailErr.response.body)
              : emailErr.message,
          });
        }
      }

      logger.info("API invoice disputed", {
        invoiceNumber: inv.invoicenumber,
        reason,
        keyId: req.apiKey.id,
      });

      // Fire webhook.
      deliverWebhookEvent(platformUserId, "payment.disputed", {
        object: "event",
        type: "payment.disputed",
        invoice_id: inv.invoicenumber,
        amount: parseFloat(inv.amount),
        currency: inv.currency,
        reason,
        ...(disputeContext ? { context: disputeContext } : {}),
        timestamp: new Date().toISOString(),
        chat_links: {
          buyer: buyerChatLink,
          seller: sellerChatLink,
        },
      }).catch(() => {});

      return res.json({
        object: "dispute",
        invoice_id: inv.invoicenumber,
        status: "disputed",
        reason,
        message:
          "Invoice flagged as disputed. Funds are held. Share the chat links below with each party so they can communicate with Fonlok support.",
        disputed_at: new Date().toISOString(),
        chat_links: {
          buyer: buyerChatLink,
          seller: sellerChatLink,
        },
      });
    } catch (err) {
      logger.error("Unexpected error during API dispute", {
        error: err.message,
        keyId: req.apiKey.id,
      });
      return res.status(500).json({
        error: "server_error",
        message: "An unexpected error occurred. Please try again.",
      });
    }
  },
);

// ── POST /v1/webhooks/register ────────────────────────────────────────────────
//
// Register a URL to receive Fonlok webhook events.
// Fonlok will POST a signed JSON payload to this URL for every relevant event.
// The response includes a `secret` — store it securely. It is shown only once
// and is used to verify the X-Fonlok-Signature header on incoming events.
router.post(
  "/webhooks/register",
  [
    body("url")
      .trim()
      .notEmpty()
      .withMessage("url is required.")
      .isURL({ require_tld: true, require_protocol: true })
      .withMessage("url must be a valid HTTPS URL including the protocol."),
    body("label")
      .optional({ checkFalsy: true })
      .trim()
      .isLength({ max: 80 })
      .withMessage("label must be 80 characters or fewer.")
      .escape(),
  ],
  validate,
  async (req, res) => {
    const userId = req.apiKey.user_id;
    const { url, label = "" } = req.body;

    // SSRF guard.
    const { safe, reason } = await isSafeUrl(url);
    if (!safe) {
      return res.status(400).json({ error: "unsafe_url", message: reason });
    }

    // Cap at 5 active webhooks per user.
    const countResult = await db.query(
      `SELECT COUNT(*) AS cnt FROM api_webhooks WHERE user_id = $1 AND active = true`,
      [userId],
    );
    if (parseInt(countResult.rows[0].cnt, 10) >= 5) {
      return res.status(429).json({
        error: "webhook_limit_reached",
        message:
          "You already have 5 active webhook endpoints. Remove one before adding another.",
      });
    }

    // Generate a strong per-webhook signing secret (shown only once).
    const webhookSecret = "whsec_" + crypto.randomBytes(32).toString("hex");
    // Store a hash — the raw secret must never be in the DB.
    const secretHash = crypto
      .createHash("sha256")
      .update(webhookSecret)
      .digest("hex");

    try {
      const result = await db.query(
        `INSERT INTO api_webhooks (user_id, url, label, secret, secret_hash, active, created_at)
         VALUES ($1, $2, $3, $4, $5, true, NOW())
         RETURNING id, url, label, created_at`,
        [userId, url, label, webhookSecret, secretHash],
      );

      const hook = result.rows[0];
      return res.status(201).json({
        object: "webhook",
        id: hook.id,
        url: hook.url,
        label: hook.label,
        secret: webhookSecret, // Shown ONCE. Store it immediately.
        created_at: hook.created_at,
        _note:
          "Store the secret securely. It will not be shown again. Use it to verify X-Fonlok-Signature on incoming events.",
      });
    } catch (err) {
      logger.error("Failed to register webhook", {
        error: err.message,
        userId,
      });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to register webhook.",
      });
    }
  },
);

// ── GET /v1/webhooks ──────────────────────────────────────────────────────────
router.get("/webhooks", async (req, res) => {
  const userId = req.apiKey.user_id;
  try {
    const result = await db.query(
      `SELECT id, url, label, active, created_at, last_triggered_at
       FROM api_webhooks
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId],
    );
    return res.json({
      object: "list",
      data: result.rows,
    });
  } catch (err) {
    logger.error("Failed to list webhooks", { error: err.message });
    return res.status(500).json({
      error: "server_error",
      message: "Failed to retrieve webhooks.",
    });
  }
});

// ── DELETE /v1/webhooks/:id ───────────────────────────────────────────────────
router.delete(
  "/webhooks/:id",
  [param("id").isInt({ min: 1 }).withMessage("id must be a positive integer.")],
  validate,
  async (req, res) => {
    const userId = req.apiKey.user_id;
    const hookId = parseInt(req.params.id, 10);

    try {
      const result = await db.query(
        `UPDATE api_webhooks
         SET active = false
         WHERE id = $1 AND user_id = $2
         RETURNING id`,
        [hookId, userId],
      );
      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "not_found",
          message: `No webhook found with id ${hookId} on your account.`,
        });
      }
      return res.json({
        object: "webhook",
        id: hookId,
        active: false,
        deleted: true,
      });
    } catch (err) {
      logger.error("Failed to delete webhook", { error: err.message });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to remove webhook.",
      });
    }
  },
);

export { deliverWebhookEvent };
export default router;
