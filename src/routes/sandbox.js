/**
 * sandbox.js — Sandbox API routes.
 *
 * All routes require a valid sk_test_* API key via sandboxAuth middleware.
 * These routes are completely isolated from production data — they read and
 * write only to the sandbox_invoices and sandbox_transactions tables.
 *
 * No real payments are initiated. No real payouts are processed.
 * No production tables are ever touched.
 *
 * Routes:
 *   GET  /sandbox/ping
 *   POST /sandbox/token                        (simulated OAuth access token)
 *
 *   POST /sandbox/invoices
 *   GET  /sandbox/invoices
 *   GET  /sandbox/invoices/:invoice_id
 *   PATCH /sandbox/invoices/:invoice_id
 *
 *   POST /sandbox/payments/initiate            (full escrow flow — needs invoice_id)
 *   POST /sandbox/payments/:reference/confirm
 *   POST /sandbox/payments/:reference/fail
 *
 *   POST /sandbox/momo/charge                  (standalone MoMo — no invoice needed)
 *   POST /sandbox/momo/:reference/confirm
 *   POST /sandbox/momo/:reference/fail
 *   GET  /sandbox/momo/:reference/status       (poll by reference)
 *   POST /sandbox/momo/withdraw                (simulate payout/disbursement)
 *   POST /sandbox/momo/webhook/simulate        (fire callback to your endpoint)
 *
 *   POST /sandbox/airtime/topup                (simulate airtime top-up)
 *   POST /sandbox/airtime/:reference/confirm
 *   POST /sandbox/airtime/:reference/fail
 *   GET  /sandbox/airtime/:reference/status
 *
 *   GET  /sandbox/transactions
 *   GET  /sandbox/transactions/:transaction_id
 */

import express from "express";
import crypto from "crypto";
import dns from "dns/promises";
import net from "net";
import axios from "axios";
import { body, param } from "express-validator";
import { validate } from "../middleware/validate.js";
import { sandboxAuth } from "../middleware/sandboxAuth.js";
import db from "../controllers/db.js";
import logger from "../utils/logger.js";

const router = express.Router();

// Every sandbox route requires a valid sandbox API key.
router.use(sandboxAuth);

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Generate a typed sandbox ID: e.g. "inv_test_a1b2c3d4e5f6g7h8" */
function sandboxId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

// ── GET /sandbox/ping ─────────────────────────────────────────────────────────
// Health check. Confirms the sandbox is reachable and the API key is valid.
router.get("/ping", (req, res) => {
  res.json({
    object: "sandbox_status",
    status: "ok",
    environment: "sandbox",
    key_label: req.sandboxKey.label,
    message:
      "The Fonlok sandbox is live. No real transactions will be processed.",
    timestamp: new Date().toISOString(),
    _sandbox: true,
  });
});

// ── POST /sandbox/invoices — create a test invoice ───────────────────────────
router.post(
  "/invoices",
  [
    body("title")
      .trim()
      .notEmpty()
      .withMessage("title is required.")
      .isLength({ max: 200 })
      .withMessage("title must be 200 characters or fewer."),
    body("amount")
      .notEmpty()
      .withMessage("amount is required.")
      .isFloat({ min: 1 })
      .withMessage("amount must be a positive number."),
    body("currency")
      .optional()
      .isIn(["XAF"])
      .withMessage("Only XAF is supported in the sandbox."),
    body("seller_email")
      .trim()
      .isEmail()
      .withMessage("A valid seller_email is required.")
      .normalizeEmail(),
    body("buyer_email")
      .optional({ checkFalsy: true })
      .isEmail()
      .withMessage("buyer_email must be a valid email if provided.")
      .normalizeEmail(),
    body("description")
      .optional({ checkFalsy: true })
      .isLength({ max: 2000 })
      .withMessage("description must be 2000 characters or fewer."),
  ],
  validate,
  async (req, res) => {
    const keyId = req.sandboxKey.id;
    const {
      title,
      amount,
      currency = "XAF",
      seller_email,
      buyer_email = null,
      description = null,
    } = req.body;

    const invoiceId = sandboxId("inv_test");

    try {
      await db.query(
        `INSERT INTO sandbox_invoices
           (sandbox_key_id, invoice_id, title, description, amount, currency,
            seller_email, buyer_email, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW(), NOW())`,
        [
          keyId,
          invoiceId,
          title,
          description,
          amount,
          currency,
          seller_email,
          buyer_email,
        ],
      );

      return res.status(201).json({
        object: "sandbox_invoice",
        id: invoiceId,
        title,
        description,
        amount: parseFloat(amount),
        currency,
        seller_email,
        buyer_email,
        status: "pending",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        _sandbox: true,
      });
    } catch (err) {
      logger.error("Failed to create sandbox invoice", { error: err.message });
      return res
        .status(500)
        .json({ error: "server_error", message: "Failed to create invoice." });
    }
  },
);

// ── GET /sandbox/invoices — list invoices for this key ───────────────────────
router.get("/invoices", async (req, res) => {
  const keyId = req.sandboxKey.id;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const [rows, countRow] = await Promise.all([
      db.query(
        `SELECT invoice_id AS id, title, description, amount, currency,
                seller_email, buyer_email, status, created_at, updated_at
         FROM sandbox_invoices
         WHERE sandbox_key_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [keyId, limit, offset],
      ),
      db.query(
        `SELECT COUNT(*) AS total FROM sandbox_invoices WHERE sandbox_key_id = $1`,
        [keyId],
      ),
    ]);

    return res.json({
      object: "list",
      data: rows.rows.map((r) => ({
        ...r,
        amount: parseFloat(r.amount),
        _sandbox: true,
      })),
      total: parseInt(countRow.rows[0].total, 10),
      limit,
      offset,
    });
  } catch (err) {
    logger.error("Failed to list sandbox invoices", { error: err.message });
    return res.status(500).json({
      error: "server_error",
      message: "Failed to retrieve invoices.",
    });
  }
});

// ── GET /sandbox/invoices/:invoice_id ────────────────────────────────────────
router.get(
  "/invoices/:invoice_id",
  [param("invoice_id").trim().notEmpty().withMessage("invoice_id is required.")],
  validate,
  async (req, res) => {
    const keyId = req.sandboxKey.id;
    const { invoice_id } = req.params;

    try {
      const result = await db.query(
        `SELECT invoice_id AS id, title, description, amount, currency,
                seller_email, buyer_email, status, created_at, updated_at
         FROM sandbox_invoices
         WHERE invoice_id = $1 AND sandbox_key_id = $2`,
        [invoice_id, keyId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "not_found",
          message: `No sandbox invoice found with id '${invoice_id}'.`,
        });
      }

      const row = result.rows[0];
      return res.json({ ...row, amount: parseFloat(row.amount), _sandbox: true });
    } catch (err) {
      logger.error("Failed to fetch sandbox invoice", { error: err.message });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to retrieve invoice.",
      });
    }
  },
);

// ── PATCH /sandbox/invoices/:invoice_id — update invoice status ──────────────
const VALID_STATUSES = ["pending", "paid", "delivered", "cancelled", "disputed"];

router.patch(
  "/invoices/:invoice_id",
  [
    param("invoice_id").trim().notEmpty().withMessage("invoice_id is required."),
    body("status")
      .isIn(VALID_STATUSES)
      .withMessage(`status must be one of: ${VALID_STATUSES.join(", ")}.`),
  ],
  validate,
  async (req, res) => {
    const keyId = req.sandboxKey.id;
    const { invoice_id } = req.params;
    const { status } = req.body;

    try {
      const result = await db.query(
        `UPDATE sandbox_invoices
         SET status = $1, updated_at = NOW()
         WHERE invoice_id = $2 AND sandbox_key_id = $3
         RETURNING invoice_id AS id, title, description, amount, currency,
                   seller_email, buyer_email, status, created_at, updated_at`,
        [status, invoice_id, keyId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "not_found",
          message: `No sandbox invoice found with id '${invoice_id}'.`,
        });
      }

      const row = result.rows[0];
      return res.json({ ...row, amount: parseFloat(row.amount), _sandbox: true });
    } catch (err) {
      logger.error("Failed to update sandbox invoice", { error: err.message });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to update invoice.",
      });
    }
  },
);

// ── POST /sandbox/payments/initiate — simulate a payment prompt ──────────────
router.post(
  "/payments/initiate",
  [
    body("invoice_id").trim().notEmpty().withMessage("invoice_id is required."),
    body("phone_number")
      .trim()
      .matches(/^237[62]\d{8}$/)
      .withMessage(
        "phone_number must be a valid Cameroonian number starting with 237 (e.g. 237670000000).",
      ),
    body("amount")
      .notEmpty()
      .withMessage("amount is required.")
      .isFloat({ min: 1 })
      .withMessage("amount must be a positive number."),
  ],
  validate,
  async (req, res) => {
    const keyId = req.sandboxKey.id;
    const { invoice_id, phone_number, amount } = req.body;

    // Verify the invoice exists and belongs to this key.
    const invResult = await db.query(
      `SELECT invoice_id, status FROM sandbox_invoices WHERE invoice_id = $1 AND sandbox_key_id = $2`,
      [invoice_id, keyId],
    );

    if (invResult.rows.length === 0) {
      return res.status(404).json({
        error: "invoice_not_found",
        message: `No sandbox invoice found with id '${invoice_id}'.`,
      });
    }

    const inv = invResult.rows[0];
    if (inv.status === "paid" || inv.status === "cancelled") {
      return res.status(409).json({
        error: "invalid_invoice_status",
        message: `Cannot initiate payment for an invoice with status '${inv.status}'.`,
      });
    }

    // Determine provider from phone number prefix (mirrors production logic).
    const d5 = phone_number.charAt(4);
    const d6 = phone_number.charAt(5);
    let provider;
    if (d5 === "7" || d5 === "8") provider = "MTN";
    else if (d5 === "6") provider = "ORANGE";
    else if (d5 === "9") provider = d6 === "9" ? "MTN" : "ORANGE";
    else provider = "MTN";

    const reference = sandboxId("ref_test");
    const transactionId = sandboxId("txn_test");

    try {
      await db.query(
        `INSERT INTO sandbox_transactions
           (sandbox_key_id, transaction_id, invoice_id, amount, currency,
            provider, phone_number, status, reference, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'XAF', $5, $6, 'pending', $7, NOW(), NOW())`,
        [keyId, transactionId, invoice_id, amount, provider, phone_number, reference],
      );

      return res.status(201).json({
        object: "sandbox_payment",
        transaction_id: transactionId,
        reference,
        invoice_id,
        amount: parseFloat(amount),
        currency: "XAF",
        provider,
        phone_number,
        status: "pending",
        message: `Sandbox: A simulated ${provider} Mobile Money prompt was sent to ${phone_number}. No real money moved.`,
        created_at: new Date().toISOString(),
        _sandbox: true,
        _next_steps: {
          confirm: `POST /sandbox/payments/${reference}/confirm`,
          fail: `POST /sandbox/payments/${reference}/fail`,
        },
      });
    } catch (err) {
      logger.error("Failed to initiate sandbox payment", { error: err.message });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to initiate payment.",
      });
    }
  },
);

// ── POST /sandbox/payments/:reference/confirm ────────────────────────────────
router.post(
  "/payments/:reference/confirm",
  [
    param("reference")
      .trim()
      .notEmpty()
      .withMessage("reference is required."),
  ],
  validate,
  async (req, res) => {
    const keyId = req.sandboxKey.id;
    const { reference } = req.params;

    try {
      const result = await db.query(
        `UPDATE sandbox_transactions
         SET status = 'success', updated_at = NOW()
         WHERE reference = $1 AND sandbox_key_id = $2 AND status = 'pending'
         RETURNING transaction_id AS id, invoice_id, amount, currency,
                   provider, phone_number, status, reference, created_at, updated_at`,
        [reference, keyId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "not_found",
          message: `No pending sandbox payment found with reference '${reference}'. It may already be confirmed, failed, or may not belong to this key.`,
        });
      }

      const txn = result.rows[0];

      // Mark the linked invoice as paid.
      await db.query(
        `UPDATE sandbox_invoices
         SET status = 'paid', updated_at = NOW()
         WHERE invoice_id = $1 AND sandbox_key_id = $2`,
        [txn.invoice_id, keyId],
      );

      return res.json({
        object: "sandbox_payment",
        ...txn,
        amount: parseFloat(txn.amount),
        _sandbox: true,
        message:
          "Sandbox: Payment confirmed. The linked invoice has been updated to 'paid'.",
      });
    } catch (err) {
      logger.error("Failed to confirm sandbox payment", { error: err.message });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to confirm payment.",
      });
    }
  },
);

// ── POST /sandbox/payments/:reference/fail ───────────────────────────────────
router.post(
  "/payments/:reference/fail",
  [
    param("reference").trim().notEmpty().withMessage("reference is required."),
    body("reason")
      .optional({ checkFalsy: true })
      .isLength({ max: 300 })
      .withMessage("reason must be 300 characters or fewer."),
  ],
  validate,
  async (req, res) => {
    const keyId = req.sandboxKey.id;
    const { reference } = req.params;
    const reason = req.body?.reason || "Simulated payment failure.";

    try {
      const result = await db.query(
        `UPDATE sandbox_transactions
         SET status = 'failed', updated_at = NOW()
         WHERE reference = $1 AND sandbox_key_id = $2 AND status = 'pending'
         RETURNING transaction_id AS id, invoice_id, amount, currency,
                   provider, phone_number, status, reference, created_at, updated_at`,
        [reference, keyId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "not_found",
          message: `No pending sandbox payment found with reference '${reference}'.`,
        });
      }

      const txn = result.rows[0];
      return res.json({
        object: "sandbox_payment",
        ...txn,
        amount: parseFloat(txn.amount),
        failure_reason: reason,
        _sandbox: true,
        message: "Sandbox: Payment failed.",
      });
    } catch (err) {
      logger.error("Failed to fail sandbox payment", { error: err.message });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to process failure.",
      });
    }
  },
);

// ── GET /sandbox/transactions ─────────────────────────────────────────────────
router.get("/transactions", async (req, res) => {
  const keyId = req.sandboxKey.id;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const [rows, countRow] = await Promise.all([
      db.query(
        `SELECT transaction_id AS id, invoice_id, amount, currency, provider,
                phone_number, status, reference, created_at, updated_at
         FROM sandbox_transactions
         WHERE sandbox_key_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [keyId, limit, offset],
      ),
      db.query(
        `SELECT COUNT(*) AS total FROM sandbox_transactions WHERE sandbox_key_id = $1`,
        [keyId],
      ),
    ]);

    return res.json({
      object: "list",
      data: rows.rows.map((r) => ({
        ...r,
        amount: parseFloat(r.amount),
        _sandbox: true,
      })),
      total: parseInt(countRow.rows[0].total, 10),
      limit,
      offset,
    });
  } catch (err) {
    logger.error("Failed to list sandbox transactions", { error: err.message });
    return res.status(500).json({
      error: "server_error",
      message: "Failed to retrieve transactions.",
    });
  }
});

// ── GET /sandbox/transactions/:transaction_id ────────────────────────────────
router.get(
  "/transactions/:transaction_id",
  [
    param("transaction_id")
      .trim()
      .notEmpty()
      .withMessage("transaction_id is required."),
  ],
  validate,
  async (req, res) => {
    const keyId = req.sandboxKey.id;
    const { transaction_id } = req.params;

    try {
      const result = await db.query(
        `SELECT transaction_id AS id, invoice_id, amount, currency, provider,
                phone_number, status, reference, created_at, updated_at
         FROM sandbox_transactions
         WHERE transaction_id = $1 AND sandbox_key_id = $2`,
        [transaction_id, keyId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "not_found",
          message: `No sandbox transaction found with id '${transaction_id}'.`,
        });
      }

      const row = result.rows[0];
      return res.json({ ...row, amount: parseFloat(row.amount), _sandbox: true });
    } catch (err) {
      logger.error("Failed to fetch sandbox transaction", { error: err.message });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to retrieve transaction.",
      });
    }
  },
);

// ────────────────────────────────────────────────────────────────────────────
// STANDALONE MOMO TESTING — no invoice required
//
// For developers who only want to test the Mobile Money charge flow in
// isolation (e.g. a payment gateway, an e-commerce checkout, a utility
// payment app) without building an escrow invoice first.
//
// The lifecycle mirrors the payment routes above:
//   1. POST /sandbox/momo/charge          → status: pending, returns reference
//   2. POST /sandbox/momo/:ref/confirm    → status: success
//      POST /sandbox/momo/:ref/fail       → status: failed
// ────────────────────────────────────────────────────────────────────────────

// ── POST /sandbox/momo/charge ─────────────────────────────────────────────
router.post(
  "/momo/charge",
  [
    body("phone_number")
      .trim()
      .matches(/^237[62]\d{8}$/)
      .withMessage(
        "phone_number must be a valid Cameroonian number starting with 237 (e.g. 237670000000).",
      ),
    body("amount")
      .notEmpty()
      .withMessage("amount is required.")
      .isFloat({ min: 1 })
      .withMessage("amount must be a positive number."),
    body("currency")
      .optional()
      .isIn(["XAF"])
      .withMessage("Only XAF is supported in the sandbox."),
    body("description")
      .optional({ checkFalsy: true })
      .isLength({ max: 300 })
      .withMessage("description must be 300 characters or fewer."),
  ],
  validate,
  async (req, res) => {
    const keyId = req.sandboxKey.id;
    const {
      phone_number,
      amount,
      currency = "XAF",
      description = null,
    } = req.body;

    // Determine provider from number prefix — same logic as production.
    const d5 = phone_number.charAt(4);
    const d6 = phone_number.charAt(5);
    let provider;
    if (d5 === "7" || d5 === "8") provider = "MTN";
    else if (d5 === "6") provider = "ORANGE";
    else if (d5 === "9") provider = d6 === "9" ? "MTN" : "ORANGE";
    else provider = "MTN";

    const reference = sandboxId("ref_test");
    const transactionId = sandboxId("txn_test");

    try {
      await db.query(
        `INSERT INTO sandbox_transactions
           (sandbox_key_id, transaction_id, invoice_id, amount, currency,
            provider, phone_number, status, reference, type, direction, description,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, 'charge', 'inbound', $9, NOW(), NOW())`,
        // invoice_id stored as 'standalone' — no FK to sandbox_invoices for pure MoMo charges.
        [keyId, transactionId, "standalone", amount, currency, provider, phone_number, reference, description],
      );

      return res.status(201).json({
        object: "sandbox_momo_charge",
        transaction_id: transactionId,
        reference,
        amount: parseFloat(amount),
        currency,
        provider,
        phone_number,
        description,
        status: "pending",
        message: `Sandbox: A simulated ${provider} Mobile Money prompt was sent to ${phone_number}. No real money moved.`,
        created_at: new Date().toISOString(),
        _sandbox: true,
        _next_steps: {
          confirm: `POST /sandbox/momo/${reference}/confirm`,
          fail: `POST /sandbox/momo/${reference}/fail`,
        },
      });
    } catch (err) {
      logger.error("Failed to initiate standalone MoMo charge", { error: err.message });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to initiate charge.",
      });
    }
  },
);

// ── POST /sandbox/momo/:reference/confirm ────────────────────────────────────
router.post(
  "/momo/:reference/confirm",
  [param("reference").trim().notEmpty().withMessage("reference is required.")],
  validate,
  async (req, res) => {
    const keyId = req.sandboxKey.id;
    const { reference } = req.params;

    try {
      const result = await db.query(
        `UPDATE sandbox_transactions
         SET status = 'success', updated_at = NOW()
         WHERE reference = $1 AND sandbox_key_id = $2 AND status = 'pending'
         RETURNING transaction_id AS id, invoice_id, amount, currency,
                   provider, phone_number, status, reference, created_at, updated_at`,
        [reference, keyId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "not_found",
          message: `No pending sandbox MoMo charge found with reference '${reference}'. It may already be confirmed, failed, or may not belong to this key.`,
        });
      }

      const txn = result.rows[0];
      return res.json({
        object: "sandbox_momo_charge",
        ...txn,
        amount: parseFloat(txn.amount),
        _sandbox: true,
        message: "Sandbox: MoMo charge confirmed. No real money moved.",
      });
    } catch (err) {
      logger.error("Failed to confirm standalone MoMo charge", { error: err.message });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to confirm charge.",
      });
    }
  },
);

// ── POST /sandbox/momo/:reference/fail ───────────────────────────────────────
router.post(
  "/momo/:reference/fail",
  [
    param("reference").trim().notEmpty().withMessage("reference is required."),
    body("reason")
      .optional({ checkFalsy: true })
      .isLength({ max: 300 })
      .withMessage("reason must be 300 characters or fewer."),
  ],
  validate,
  async (req, res) => {
    const keyId = req.sandboxKey.id;
    const { reference } = req.params;
    const reason = req.body?.reason || "Simulated payment failure.";

    try {
      const result = await db.query(
        `UPDATE sandbox_transactions
         SET status = 'failed', updated_at = NOW()
         WHERE reference = $1 AND sandbox_key_id = $2 AND status = 'pending'
         RETURNING transaction_id AS id, invoice_id, amount, currency,
                   provider, phone_number, status, reference, created_at, updated_at`,
        [reference, keyId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "not_found",
          message: `No pending sandbox MoMo charge found with reference '${reference}'.`,
        });
      }

      const txn = result.rows[0];
      return res.json({
        object: "sandbox_momo_charge",
        ...txn,
        amount: parseFloat(txn.amount),
        failure_reason: reason,
        _sandbox: true,
        message: "Sandbox: MoMo charge failed.",
      });
    } catch (err) {
      logger.error("Failed to fail standalone MoMo charge", { error: err.message });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to process failure.",
      });
    }
  },
);

// ────────────────────────────────────────────────────────────────────────────
// SSRF GUARD — protects the webhook simulation endpoint
//
// Before firing any outbound HTTP request to a developer-supplied callback
// URL, we resolve the hostname and reject any address that maps to a private,
// loopback, link-local, or cloud-metadata range. This prevents the sandbox
// from being weaponised as a proxy to probe internal services.
// ────────────────────────────────────────────────────────────────────────────

const PRIVATE_IP_PATTERNS = [
  /^127\./,                              // loopback
  /^10\./,                               // RFC-1918
  /^172\.(1[6-9]|2\d|3[01])\./,         // RFC-1918
  /^192\.168\./,                         // RFC-1918
  /^169\.254\./,                         // link-local / AWS metadata
  /^0\./,                                // "this" network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT RFC-6598
  /^::1$/,                               // IPv6 loopback
  /^fc00:/i,                             // IPv6 unique local
  /^fe80:/i,                             // IPv6 link-local
];

async function isSafeCallbackUrl(rawUrl) {
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
    return { safe: false, reason: `'${hostname}' is not allowed as a callback URL.` };
  }

  // Raw IP — check directly without DNS.
  if (net.isIPv4(hostname) || net.isIPv6(hostname)) {
    if (PRIVATE_IP_PATTERNS.some((r) => r.test(hostname))) {
      return { safe: false, reason: "Private IP ranges are not allowed as callback URLs." };
    }
    return { safe: true };
  }

  // Resolve hostname to IP(s) and validate each one.
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    for (const { address } of addrs) {
      if (PRIVATE_IP_PATTERNS.some((r) => r.test(address))) {
        return {
          safe: false,
          reason: `Callback URL resolves to a private IP address (${address}).`,
        };
      }
    }
  } catch {
    return { safe: false, reason: "Could not resolve the callback URL hostname." };
  }

  return { safe: true };
}

// ── POST /sandbox/token — simulated OAuth access token ────────────────────────
// Real MTN and Orange MoMo APIs require a Basic-auth token request before any
// API call. This route returns a fake but realistic token so developers can
// test their token-fetching and refresh logic without real credentials.
// The token grants no real access anywhere.
router.post("/token", (req, res) => {
  const fakeToken = "access_" + crypto.randomBytes(32).toString("hex");
  return res.json({
    object: "sandbox_token",
    access_token: fakeToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope: "profile payments",
    _sandbox: true,
    _note:
      "This token is simulated. It grants no access to real MTN or Orange APIs.",
  });
});

// ── GET /sandbox/momo/:reference/status — poll transaction status ─────────────
// Returns the current status of any sandbox MoMo transaction (charge,
// withdrawal, or airtime) by its reference. Use this for polling-based
// integrations that do not rely on webhooks.
router.get(
  "/momo/:reference/status",
  [param("reference").trim().notEmpty().withMessage("reference is required.")],
  validate,
  async (req, res) => {
    const keyId = req.sandboxKey.id;
    const { reference } = req.params;

    try {
      const result = await db.query(
        `SELECT transaction_id AS id, type, direction, invoice_id,
                amount, currency, provider, phone_number, description,
                status, reference, created_at, updated_at
         FROM sandbox_transactions
         WHERE reference = $1 AND sandbox_key_id = $2`,
        [reference, keyId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "not_found",
          message: `No sandbox transaction found with reference '${reference}'.`,
        });
      }

      const row = result.rows[0];
      return res.json({
        object: "sandbox_transaction_status",
        ...row,
        amount: parseFloat(row.amount),
        _sandbox: true,
      });
    } catch (err) {
      logger.error("Failed to fetch sandbox transaction status", {
        error: err.message,
      });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to retrieve status.",
      });
    }
  },
);

// ── POST /sandbox/momo/withdraw — simulate a disbursement/payout ──────────────
// Simulates sending money FROM your application TO a phone number.
// This is the disbursement API — the reverse of a charge.
// Use cases: paying out sellers, refunding buyers, sending commissions.
router.post(
  "/momo/withdraw",
  [
    body("phone_number")
      .trim()
      .matches(/^237[62]\d{8}$/)
      .withMessage(
        "phone_number must be a valid Cameroonian number (237XXXXXXXXX).",
      ),
    body("amount")
      .notEmpty()
      .withMessage("amount is required.")
      .isFloat({ min: 1 })
      .withMessage("amount must be a positive number."),
    body("description")
      .optional({ checkFalsy: true })
      .isLength({ max: 300 })
      .withMessage("description must be 300 characters or fewer."),
  ],
  validate,
  async (req, res) => {
    const keyId = req.sandboxKey.id;
    const { phone_number, amount, description = null } = req.body;

    const d5 = phone_number.charAt(4);
    const d6 = phone_number.charAt(5);
    let provider;
    if (d5 === "7" || d5 === "8") provider = "MTN";
    else if (d5 === "6") provider = "ORANGE";
    else if (d5 === "9") provider = d6 === "9" ? "MTN" : "ORANGE";
    else provider = "MTN";

    const reference = sandboxId("ref_test");
    const transactionId = sandboxId("txn_test");

    try {
      await db.query(
        `INSERT INTO sandbox_transactions
           (sandbox_key_id, transaction_id, invoice_id, amount, currency,
            provider, phone_number, status, reference, type, direction, description,
            created_at, updated_at)
         VALUES ($1, $2, 'standalone', $3, 'XAF', $4, $5, 'pending', $6,
                 'withdraw', 'outbound', $7, NOW(), NOW())`,
        [keyId, transactionId, amount, provider, phone_number, reference, description],
      );

      return res.status(201).json({
        object: "sandbox_withdrawal",
        transaction_id: transactionId,
        reference,
        amount: parseFloat(amount),
        currency: "XAF",
        provider,
        phone_number,
        description,
        direction: "outbound",
        status: "pending",
        message: `Sandbox: A simulated ${provider} disbursement of ${amount} XAF to ${phone_number} is pending. No real money moved.`,
        created_at: new Date().toISOString(),
        _sandbox: true,
        _next_steps: {
          confirm: `POST /sandbox/momo/${reference}/confirm`,
          fail: `POST /sandbox/momo/${reference}/fail`,
          status: `GET /sandbox/momo/${reference}/status`,
        },
      });
    } catch (err) {
      logger.error("Failed to initiate sandbox withdrawal", { error: err.message });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to initiate withdrawal.",
      });
    }
  },
);

// ── POST /sandbox/momo/webhook/simulate — fire a webhook to your endpoint ─────
// Sends a simulated MoMo payment notification POST to the developer's own
// callback URL. Use this to test your webhook handler without waiting for a
// real provider to send you one.
//
// SECURITY: The callback_url is SSRF-guarded — it is resolved via DNS and
// rejected if it maps to any private, loopback, or link-local address. An
// attacker cannot use this endpoint to probe internal services or cloud
// metadata endpoints. The outbound request has a hard 5-second timeout and
// does not follow redirects.
router.post(
  "/momo/webhook/simulate",
  [
    body("reference")
      .trim()
      .notEmpty()
      .withMessage("reference is required."),
    body("callback_url")
      .trim()
      .notEmpty()
      .withMessage("callback_url is required.")
      .isURL({ require_tld: true, require_protocol: true })
      .withMessage(
        "callback_url must be a valid URL including the protocol (https://...).",
      ),
    body("format")
      .optional()
      .isIn(["mtn", "orange", "generic"])
      .withMessage("format must be one of: mtn, orange, generic."),
  ],
  validate,
  async (req, res) => {
    const keyId = req.sandboxKey.id;
    const { reference, callback_url, format = "generic" } = req.body;

    // ── 1. SSRF check ────────────────────────────────────────────────────────
    const { safe, reason } = await isSafeCallbackUrl(callback_url);
    if (!safe) {
      return res.status(400).json({ error: "unsafe_callback_url", message: reason });
    }

    // ── 2. Look up the transaction ────────────────────────────────────────────
    let txn;
    try {
      const result = await db.query(
        `SELECT transaction_id, type, amount, currency, provider,
                phone_number, status
         FROM sandbox_transactions
         WHERE reference = $1 AND sandbox_key_id = $2`,
        [reference, keyId],
      );
      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "not_found",
          message: `No sandbox transaction found with reference '${reference}'.`,
        });
      }
      txn = result.rows[0];
    } catch (err) {
      logger.error("Webhook simulate: DB lookup failed", { error: err.message });
      return res.status(500).json({ error: "server_error", message: "Database error." });
    }

    // ── 3. Build the provider-specific payload ────────────────────────────────
    const mtnStatus =
      txn.status === "success"
        ? "SUCCESSFUL"
        : txn.status === "failed"
          ? "FAILED"
          : "PENDING";
    const orangeStatus =
      txn.status === "success"
        ? "SUCCESS"
        : txn.status === "failed"
          ? "FAILED"
          : "INITIATED";

    let payload;
    if (format === "mtn") {
      payload = {
        financialTransactionId: txn.transaction_id,
        externalId: reference,
        amount: String(parseFloat(txn.amount)),
        currency: txn.currency,
        payer: { partyIdType: "MSISDN", partyId: txn.phone_number },
        payerMessage: "Fonlok sandbox",
        payeeNote: "Fonlok sandbox",
        status: mtnStatus,
        _sandbox: true,
      };
    } else if (format === "orange") {
      payload = {
        pay_token: reference,
        txnid: txn.transaction_id,
        amount: String(parseFloat(txn.amount)),
        currency: txn.currency,
        channelUserMsisdn: txn.phone_number,
        status: orangeStatus,
        description: "Fonlok sandbox",
        _sandbox: true,
      };
    } else {
      payload = {
        object: "sandbox_webhook",
        reference,
        transaction_id: txn.transaction_id,
        type: txn.type,
        amount: parseFloat(txn.amount),
        currency: txn.currency,
        provider: txn.provider,
        phone_number: txn.phone_number,
        status: txn.status,
        _sandbox: true,
      };
    }

    // ── 4. Fire the request (5 s timeout, no redirects) ──────────────────────
    let deliveryStatus = "failed";
    let responseStatus = null;
    let errorMessage = null;

    try {
      const response = await axios.post(callback_url, payload, {
        timeout: 5000,
        maxRedirects: 0,
        headers: {
          "Content-Type": "application/json",
          "X-Fonlok-Sandbox": "1",
          "User-Agent": "Fonlok-Sandbox/1.0",
        },
        validateStatus: () => true, // never throw on 4xx/5xx
      });
      responseStatus = response.status;
      deliveryStatus = "delivered";
    } catch (err) {
      errorMessage = err.message;
    }

    // ── 5. Log the attempt (fire-and-forget) ─────────────────────────────────
    db.query(
      `INSERT INTO sandbox_webhook_logs
         (sandbox_key_id, reference, callback_url, payload, response_status, error, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        keyId,
        reference,
        callback_url,
        JSON.stringify(payload),
        responseStatus,
        errorMessage,
      ],
    ).catch((e) =>
      logger.warn("Failed to log webhook attempt", { error: e.message }),
    );

    if (deliveryStatus === "delivered") {
      return res.json({
        object: "sandbox_webhook_delivery",
        status: "delivered",
        callback_url,
        format,
        response_http_status: responseStatus,
        payload_sent: payload,
        _sandbox: true,
      });
    } else {
      return res.status(502).json({
        object: "sandbox_webhook_delivery",
        status: "failed",
        callback_url,
        error: errorMessage,
        payload_attempted: payload,
        _sandbox: true,
        message:
          "The sandbox fired the request but your endpoint did not respond. " +
          "Ensure your callback URL is publicly reachable and returns a 2xx status.",
      });
    }
  },
);

// ────────────────────────────────────────────────────────────────────────────
// AIRTIME TOP-UP — simulate crediting airtime to a phone number
//
// Works for both MTN and Orange. The lifecycle is identical to a charge:
//   1. POST /sandbox/airtime/topup     → status: pending, returns reference
//   2. POST /sandbox/airtime/:ref/confirm  → status: success
//      POST /sandbox/airtime/:ref/fail     → status: failed
//   GET  /sandbox/airtime/:ref/status      → poll current status
// ────────────────────────────────────────────────────────────────────────────

// ── POST /sandbox/airtime/topup ───────────────────────────────────────────────
router.post(
  "/airtime/topup",
  [
    body("phone_number")
      .trim()
      .matches(/^237[62]\d{8}$/)
      .withMessage(
        "phone_number must be a valid Cameroonian number (237XXXXXXXXX).",
      ),
    body("amount")
      .notEmpty()
      .withMessage("amount is required.")
      .isInt({ min: 100, max: 50000 })
      .withMessage("Airtime amount must be between 100 and 50,000 XAF."),
    body("description")
      .optional({ checkFalsy: true })
      .isLength({ max: 200 })
      .withMessage("description must be 200 characters or fewer."),
  ],
  validate,
  async (req, res) => {
    const keyId = req.sandboxKey.id;
    const { phone_number, amount, description = null } = req.body;

    const d5 = phone_number.charAt(4);
    const d6 = phone_number.charAt(5);
    let provider;
    if (d5 === "7" || d5 === "8") provider = "MTN";
    else if (d5 === "6") provider = "ORANGE";
    else if (d5 === "9") provider = d6 === "9" ? "MTN" : "ORANGE";
    else provider = "MTN";

    const reference = sandboxId("ref_test");
    const transactionId = sandboxId("txn_test");

    try {
      await db.query(
        `INSERT INTO sandbox_transactions
           (sandbox_key_id, transaction_id, invoice_id, amount, currency,
            provider, phone_number, status, reference, type, direction, description,
            created_at, updated_at)
         VALUES ($1, $2, 'standalone', $3, 'XAF', $4, $5, 'pending', $6,
                 'airtime', 'outbound', $7, NOW(), NOW())`,
        [keyId, transactionId, amount, provider, phone_number, reference, description],
      );

      return res.status(201).json({
        object: "sandbox_airtime_topup",
        transaction_id: transactionId,
        reference,
        amount: parseInt(amount, 10),
        currency: "XAF",
        provider,
        phone_number,
        description,
        status: "pending",
        message: `Sandbox: A simulated ${provider} airtime top-up of ${amount} XAF to ${phone_number} is pending. No real airtime will be credited.`,
        created_at: new Date().toISOString(),
        _sandbox: true,
        _next_steps: {
          confirm: `POST /sandbox/airtime/${reference}/confirm`,
          fail: `POST /sandbox/airtime/${reference}/fail`,
          status: `GET /sandbox/airtime/${reference}/status`,
        },
      });
    } catch (err) {
      logger.error("Failed to initiate sandbox airtime top-up", {
        error: err.message,
      });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to initiate airtime top-up.",
      });
    }
  },
);

// ── POST /sandbox/airtime/:reference/confirm ──────────────────────────────────
router.post(
  "/airtime/:reference/confirm",
  [param("reference").trim().notEmpty().withMessage("reference is required.")],
  validate,
  async (req, res) => {
    const keyId = req.sandboxKey.id;
    const { reference } = req.params;

    try {
      const result = await db.query(
        `UPDATE sandbox_transactions
         SET status = 'success', updated_at = NOW()
         WHERE reference = $1 AND sandbox_key_id = $2
           AND status = 'pending' AND type = 'airtime'
         RETURNING transaction_id AS id, amount, currency, provider,
                   phone_number, description, status, reference, created_at, updated_at`,
        [reference, keyId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "not_found",
          message: `No pending sandbox airtime top-up found with reference '${reference}'.`,
        });
      }

      const row = result.rows[0];
      return res.json({
        object: "sandbox_airtime_topup",
        ...row,
        amount: parseInt(row.amount, 10),
        _sandbox: true,
        message: "Sandbox: Airtime top-up confirmed. No real airtime was credited.",
      });
    } catch (err) {
      logger.error("Failed to confirm sandbox airtime top-up", {
        error: err.message,
      });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to confirm airtime top-up.",
      });
    }
  },
);

// ── POST /sandbox/airtime/:reference/fail ─────────────────────────────────────
router.post(
  "/airtime/:reference/fail",
  [
    param("reference").trim().notEmpty().withMessage("reference is required."),
    body("reason")
      .optional({ checkFalsy: true })
      .isLength({ max: 300 })
      .withMessage("reason must be 300 characters or fewer."),
  ],
  validate,
  async (req, res) => {
    const keyId = req.sandboxKey.id;
    const { reference } = req.params;
    const reason = req.body?.reason || "Simulated airtime delivery failure.";

    try {
      const result = await db.query(
        `UPDATE sandbox_transactions
         SET status = 'failed', updated_at = NOW()
         WHERE reference = $1 AND sandbox_key_id = $2
           AND status = 'pending' AND type = 'airtime'
         RETURNING transaction_id AS id, amount, currency, provider,
                   phone_number, status, reference, created_at, updated_at`,
        [reference, keyId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "not_found",
          message: `No pending sandbox airtime top-up found with reference '${reference}'.`,
        });
      }

      const row = result.rows[0];
      return res.json({
        object: "sandbox_airtime_topup",
        ...row,
        amount: parseInt(row.amount, 10),
        failure_reason: reason,
        _sandbox: true,
        message: "Sandbox: Airtime top-up failed.",
      });
    } catch (err) {
      logger.error("Failed to fail sandbox airtime top-up", { error: err.message });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to process failure.",
      });
    }
  },
);

// ── GET /sandbox/airtime/:reference/status ────────────────────────────────────
router.get(
  "/airtime/:reference/status",
  [param("reference").trim().notEmpty().withMessage("reference is required.")],
  validate,
  async (req, res) => {
    const keyId = req.sandboxKey.id;
    const { reference } = req.params;

    try {
      const result = await db.query(
        `SELECT transaction_id AS id, type, amount, currency, provider,
                phone_number, description, status, reference, created_at, updated_at
         FROM sandbox_transactions
         WHERE reference = $1 AND sandbox_key_id = $2 AND type = 'airtime'`,
        [reference, keyId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "not_found",
          message: `No sandbox airtime top-up found with reference '${reference}'.`,
        });
      }

      const row = result.rows[0];
      return res.json({
        object: "sandbox_airtime_status",
        ...row,
        amount: parseInt(row.amount, 10),
        _sandbox: true,
      });
    } catch (err) {
      logger.error("Failed to fetch sandbox airtime status", { error: err.message });
      return res.status(500).json({
        error: "server_error",
        message: "Failed to retrieve status.",
      });
    }
  },
);

export default router;
