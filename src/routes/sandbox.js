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
 *   POST /sandbox/momo/charge                  (standalone MoMo test — no invoice needed)
 *   POST /sandbox/momo/:reference/confirm
 *   POST /sandbox/momo/:reference/fail
 *
 *   GET  /sandbox/transactions
 *   GET  /sandbox/transactions/:transaction_id
 */

import express from "express";
import crypto from "crypto";
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
            provider, phone_number, status, reference, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, NOW(), NOW())`,
        // invoice_id is null for standalone MoMo charges — stored as the
        // literal string 'standalone' so the NOT NULL constraint is satisfied
        // and it's queryable without a foreign key to sandbox_invoices.
        [keyId, transactionId, "standalone", amount, currency, provider, phone_number, reference],
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

export default router;
