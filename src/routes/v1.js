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
 *   POST /v1/invoices                              — create an escrow invoice
 *   GET  /v1/invoices/:invoice_id                  — get invoice by ID
 *   POST /v1/payments/initiate                     — trigger buyer MoMo prompt
 *   GET  /v1/payments/:reference/status            — poll payment status
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
import { body, param } from "express-validator";
import { validate } from "../middleware/validate.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import db from "../controllers/db.js";
import logger from "../utils/logger.js";

dotenv.config();

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
    return { safe: false, reason: `'${hostname}' is not an allowed webhook URL.` };
  }
  if (net.isIPv4(hostname) || net.isIPv6(hostname)) {
    if (PRIVATE_IP_PATTERNS.some((r) => r.test(hostname))) {
      return { safe: false, reason: "Private IP addresses are not allowed as webhook URLs." };
    }
    return { safe: true };
  }
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    for (const { address } of addrs) {
      if (PRIVATE_IP_PATTERNS.some((r) => r.test(address))) {
        return { safe: false, reason: `Webhook URL resolves to a private IP (${address}).` };
      }
    }
  } catch {
    return { safe: false, reason: "Could not resolve the webhook URL hostname." };
  }
  return { safe: true };
}

/**
 * Sign an outbound webhook payload.
 * Returns the value of the X-Fonlok-Signature header the receiver should verify.
 * Algorithm: HMAC-SHA256(raw JSON body, webhook_secret)
 */
function signWebhookPayload(rawBody, secret) {
  return "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");
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
        logger.info("Webhook delivered", { hookId: hook.id, event: eventType, url: hook.url });
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
    message: "Fonlok live API is operational. Real transactions will be processed.",
    timestamp: new Date().toISOString(),
  });
});

// ── POST /v1/invoices — create a production escrow invoice ───────────────────
//
// The invoice is created on behalf of the authenticated API key owner (the seller).
// The seller must have a verified Fonlok account and a registered Mobile Money
// phone number (required for payout when the buyer confirms delivery).
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
    body("buyer_email")
      .optional({ checkFalsy: true })
      .isEmail()
      .withMessage("buyer_email must be a valid email address.")
      .normalizeEmail(),
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
      .withMessage("expires_at must be a valid ISO 8601 date (e.g. 2026-12-31)."),
  ],
  validate,
  async (req, res) => {
    const sellerId = req.apiKey.user_id;
    const {
      title,
      amount,
      currency = "XAF",
      buyer_email = null,
      description = null,
      reference = null,
      expires_at = null,
    } = req.body;

    try {
      // Verify the seller account exists and has a phone number for payout.
      const sellerResult = await db.query(
        `SELECT id, email, phone, is_verified FROM users WHERE id = $1`,
        [sellerId],
      );
      if (sellerResult.rows.length === 0) {
        return res.status(403).json({
          error: "account_not_found",
          message: "The Fonlok account associated with this API key no longer exists.",
        });
      }
      const seller = sellerResult.rows[0];
      if (!seller.phone) {
        return res.status(403).json({
          error: "no_payout_number",
          message:
            "Your Fonlok account does not have a Mobile Money number set. Add one in your profile before creating live invoices.",
        });
      }

      // Ensure external reference is unique per seller if provided.
      if (reference) {
        const dupCheck = await db.query(
          `SELECT 1 FROM invoices WHERE userid = $1 AND external_reference = $2 LIMIT 1`,
          [sellerId, reference],
        );
        if (dupCheck.rows.length > 0) {
          return res.status(409).json({
            error: "duplicate_reference",
            message: `An invoice with reference '${reference}' already exists for your account.`,
          });
        }
      }

      const invoiceNumber = `${sellerId}-${crypto.randomBytes(6).toString("hex")}`;
      const invoiceLink = `${process.env.FRONTEND_URL}/pay/${invoiceNumber}`;

      const result = await db.query(
        `INSERT INTO invoices
           (invoicename, clientemail, currency, amount, invoicenumber, userid,
            invoicelink, description, expires_at, payment_type, external_reference,
            created_via_api)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'full', $10, true)
         RETURNING id, invoicenumber, invoicename, clientemail, currency, amount,
                   invoicelink, description, expires_at, external_reference,
                   status, created_at`,
        [
          title,
          buyer_email || seller.email,
          currency,
          parseFloat(amount),
          invoiceNumber,
          sellerId,
          invoiceLink,
          description,
          expires_at || null,
          reference || null,
        ],
      );

      const inv = result.rows[0];

      logger.info("Production invoice created via API", {
        invoiceId: inv.id,
        invoiceNumber: inv.invoicenumber,
        userId: sellerId,
        keyId: req.apiKey.id,
        amount: inv.amount,
      });

      return res.status(201).json({
        object: "invoice",
        id: inv.invoicenumber,
        title: inv.invoicename,
        description: inv.description,
        amount: parseFloat(inv.amount),
        currency: inv.currency,
        seller_id: sellerId,
        buyer_email: inv.clientemail,
        status: inv.status,
        payment_url: inv.invoicelink,
        external_reference: inv.external_reference,
        expires_at: inv.expires_at,
        created_at: inv.created_at,
      });
    } catch (err) {
      logger.error("Failed to create production invoice via API", {
        error: err.message,
        userId: sellerId,
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
  [param("invoice_id").trim().notEmpty().withMessage("invoice_id is required.")],
  validate,
  async (req, res) => {
    const sellerId = req.apiKey.user_id;
    const { invoice_id } = req.params;

    try {
      const result = await db.query(
        `SELECT id, invoicenumber, invoicename, clientemail, currency, amount,
                invoicelink, description, expires_at, external_reference,
                status, created_at, paid_at, delivered_at
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
      return res.json({
        object: "invoice",
        id: inv.invoicenumber,
        title: inv.invoicename,
        description: inv.description,
        amount: parseFloat(inv.amount),
        currency: inv.currency,
        seller_id: sellerId,
        buyer_email: inv.clientemail,
        status: inv.status,
        payment_url: inv.invoicelink,
        external_reference: inv.external_reference,
        expires_at: inv.expires_at,
        created_at: inv.created_at,
        paid_at: inv.paid_at,
        delivered_at: inv.delivered_at,
      });
    } catch (err) {
      logger.error("Failed to fetch invoice via API", { error: err.message });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to retrieve invoice.",
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
    body("invoice_id")
      .trim()
      .notEmpty()
      .withMessage("invoice_id is required."),
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
          message: "Invoice amount must be at least 500 XAF to initiate a payment.",
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
      const effectiveBuyerEmail = buyer_email || inv.clientemail;
      await db.query(
        `INSERT INTO guests (email, momo_number, invoicenumber)
         VALUES ($1, $2, $3)
         ON CONFLICT (email, invoicenumber)
         DO UPDATE SET momo_number = EXCLUDED.momo_number`,
        [effectiveBuyerEmail, phone_number, inv.invoicenumber],
      );

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
        await db.query(
          `DELETE FROM payments WHERE providerpaymentid = $1`,
          [paymentUUID],
        ).catch(() => {});
        logger.error("Campay auth failed during API payment initiation", {
          error: campayAuthErr.message,
          invoiceNumber: inv.invoicenumber,
        });
        return res.status(502).json({
          error: "payment_gateway_error",
          message: "Could not connect to the payment gateway. Please try again.",
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
        await db.query(
          `DELETE FROM payments WHERE providerpaymentid = $1`,
          [paymentUUID],
        ).catch(() => {});
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
          logger.warn("Failed to persist campay_reference", { error: e.message }),
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
        status: row.status,             // "pending" | "paid" | "failed"
        invoice_status: row.invoice_status, // "pending" | "paid" | "delivered" | "completed" | "disputed" | "cancelled"
        created_at: row.created_at,
      });
    } catch (err) {
      logger.error("Failed to fetch payment status via API", { error: err.message });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to retrieve payment status.",
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
        message: "You already have 5 active webhook endpoints. Remove one before adding another.",
      });
    }

    // Generate a strong per-webhook signing secret (shown only once).
    const webhookSecret = "whsec_" + crypto.randomBytes(32).toString("hex");
    // Store a hash — the raw secret must never be in the DB.
    const secretHash = crypto.createHash("sha256").update(webhookSecret).digest("hex");

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
        _note: "Store the secret securely. It will not be shown again. Use it to verify X-Fonlok-Signature on incoming events.",
      });
    } catch (err) {
      logger.error("Failed to register webhook", { error: err.message, userId });
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
  [
    param("id")
      .isInt({ min: 1 })
      .withMessage("id must be a positive integer."),
  ],
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
      return res.json({ object: "webhook", id: hookId, active: false, deleted: true });
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
