/**
 * invoicePayoutSplit.js — split-payout support for API-created invoices.
 *
 * A developer can attach one split to an invoice: a commission, calculated on
 * the gross invoice amount, paid to a MoMo number of their choosing when the
 * invoice is released. The seller receives gross - Fonlok fee - split.
 *
 * Money-safety rules:
 *  - The split amount is frozen when the split is stored; it never changes.
 *  - A split is dispatched at most once: it is claimed with an atomic UPDATE
 *    (pending/failed -> processing) before Campay is called.
 *  - Only a definite Campay rejection marks a split 'failed' (retriable).
 *    A timeout leaves it 'processing' because the money may have moved.
 */

import axios from "axios";
import sgMail from "@sendgrid/mail";
import db from "../controllers/db.js";
import logger from "./logger.js";
import { emailWrap, emailTable } from "./emailTemplate.js";

export const MIN_SPLIT_AMOUNT = 100; // XAF
export const MAX_SPLIT_SHARE = 0.5; // a split may never exceed 50% of the invoice
const PHONE_RE = /^237[62]\d{8}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const escapeHtml = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export function computeSplitAmount(grossAmount, type, value) {
  const gross = Number(grossAmount);
  const v = Number(value);
  return type === "percentage" ? Math.floor((gross * v) / 100) : Math.round(v);
}

/**
 * Validate a developer-supplied split object.
 * Returns { error } or { split } where split is the normalised, ready-to-store form.
 */
export function validateSplitInput(input, { grossAmount, sellerPhone }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "split must be an object." };
  }

  const phone = String(input.phone ?? "").trim();
  if (!PHONE_RE.test(phone)) {
    return {
      error:
        "split.phone must be a valid Cameroonian MoMo number (e.g. 237670000000).",
    };
  }
  if (sellerPhone && phone === sellerPhone) {
    return { error: "split.phone must be different from the seller_phone." };
  }

  const type = input.type;
  if (type !== "percentage" && type !== "fixed") {
    return { error: "split.type must be 'percentage' or 'fixed'." };
  }

  const value = Number(input.value);
  if (!Number.isFinite(value) || value <= 0) {
    return { error: "split.value must be a positive number." };
  }
  if (type === "fixed" && !Number.isInteger(value)) {
    return {
      error: "split.value must be a whole number of XAF when type is 'fixed'.",
    };
  }
  if (
    type === "percentage" &&
    (value > MAX_SPLIT_SHARE * 100 ||
      !/^\d+(\.\d{1,2})?$/.test(String(input.value)))
  ) {
    return {
      error: `split.value must be a percentage up to ${MAX_SPLIT_SHARE * 100} with at most 2 decimals.`,
    };
  }

  let name = null;
  if (input.name !== undefined && input.name !== null && input.name !== "") {
    if (typeof input.name !== "string" || input.name.trim().length > 100) {
      return {
        error: "split.name must be a string of 100 characters or fewer.",
      };
    }
    name = input.name.trim().replace(/[<>]/g, "");
  }

  let email = null;
  if (input.email !== undefined && input.email !== null && input.email !== "") {
    if (
      typeof input.email !== "string" ||
      input.email.trim().length > 255 ||
      !EMAIL_RE.test(input.email.trim())
    ) {
      return { error: "split.email must be a valid email address." };
    }
    email = input.email.trim().toLowerCase();
  }

  const amount = computeSplitAmount(grossAmount, type, value);
  if (amount < MIN_SPLIT_AMOUNT) {
    return {
      error: `The split must be at least ${MIN_SPLIT_AMOUNT} XAF for this invoice amount.`,
    };
  }
  if (amount > Math.floor(Number(grossAmount) * MAX_SPLIT_SHARE)) {
    return {
      error: `The split cannot exceed ${MAX_SPLIT_SHARE * 100}% of the invoice amount.`,
    };
  }

  return { split: { phone, name, email, type, value, amount } };
}

/** Store a validated split for an invoice. Returns the row, or null if one already exists. */
export async function createInvoiceSplit(invoiceId, apiKeyId, split) {
  const result = await db.query(
    `INSERT INTO invoice_payout_splits
       (invoice_id, api_key_id, recipient_phone, recipient_name, recipient_email, split_type, split_value, amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (invoice_id) DO NOTHING
     RETURNING *`,
    [
      invoiceId,
      apiKeyId ?? null,
      split.phone,
      split.name,
      split.email ?? null,
      split.type,
      split.value,
      split.amount,
    ],
  );
  return result.rows[0] || null;
}

export async function getInvoiceSplit(invoiceId) {
  const result = await db.query(
    "SELECT * FROM invoice_payout_splits WHERE invoice_id = $1",
    [invoiceId],
  );
  return result.rows[0] || null;
}

/** Public (API-facing) representation of a split row. */
export function formatSplit(row) {
  if (!row) return null;
  return {
    recipient: {
      phone: row.recipient_phone,
      name: row.recipient_name,
      email: row.recipient_email ?? null,
    },
    type: row.split_type,
    value: Number(row.split_value),
    amount: Number(row.amount),
    status: row.status,
    paid_at: row.paid_at,
  };
}

/**
 * Branded payout receipt for the split recipient. Goes to split.email, or to the
 * API key owner's account email when none was given.
 */
async function sendSplitReceiptEmail(invoice, split) {
  const inv = await db.query(
    "SELECT u.email AS owner_email, i.amount, i.invoicename, i.invoicenumber FROM invoices i JOIN users u ON u.id = i.userid WHERE i.id = $1",
    [invoice.id],
  );
  const row = inv.rows[0];
  const to = split.recipient_email || row?.owner_email;
  if (!to) return;

  const basis =
    split.split_type === "percentage"
      ? `${Number(split.split_value)}% of the invoice`
      : "Fixed amount";
  const name = split.recipient_name
    ? escapeHtml(split.recipient_name)
    : "there";

  await sgMail.send({
    to,
    from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
    subject: `Split payout sent \u2014 ${row.invoicenumber}`,
    html: emailWrap(
      `<h2 style="color:#0F1F3D;margin:0 0 12px;">Your split payout has been sent</h2>
      <p style="color:#475569;">Hi ${name}, your share of invoice <strong>${escapeHtml(row.invoicenumber)}</strong> has been sent to your Mobile Money account.</p>
      ${emailTable([
        ["Invoice Number", escapeHtml(row.invoicenumber)],
        ["Invoice Name", row.invoicename],
        ["Invoice Amount", `${Number(row.amount)} XAF`],
        ["Your Share", basis],
        [
          "Amount Sent",
          `${Number(split.amount)} XAF`,
          "font-weight:700;color:#16a34a;font-size:15px;",
        ],
        ["Sent To", split.recipient_phone],
        ["Status", "&#10003;&nbsp;Paid out", "color:#16a34a;font-weight:600;"],
      ])}
      <p style="color:#475569;margin-top:12px;">No further fee is deducted from this amount. Keep this email as your receipt.</p>`,
      {
        footerNote:
          "You received this email because a split payout was sent to your Mobile Money number through Fonlok.",
      },
    ),
  });
}

/**
 * Dispatch the split for an invoice whose seller payout has already succeeded.
 * Never throws: failures are recorded on the split row and returned in `status`.
 * Returns { split, dispatched } where split is the latest row (or null if none).
 */
export async function payInvoiceSplit(invoice) {
  const claim = await db.query(
    `UPDATE invoice_payout_splits
        SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
      WHERE invoice_id = $1 AND status IN ('pending', 'failed')
      RETURNING *`,
    [invoice.id],
  );

  if (claim.rows.length === 0) {
    return { split: await getInvoiceSplit(invoice.id), dispatched: false };
  }
  const split = claim.rows[0];

  try {
    const auth = await axios.post(
      `${process.env.CAMPAY_BASE_URL}token/`,
      {
        username: process.env.CAMPAY_USERNAME,
        password: process.env.CAMPAY_PASSWORD,
      },
      { timeout: 10000 },
    );
    const res = await axios.post(
      `${process.env.CAMPAY_BASE_URL}withdraw/`,
      {
        amount: String(split.amount),
        currency: "XAF",
        to: split.recipient_phone,
        description: `Fonlok split payout: ${invoice.invoicename}`,
        external_reference: `${invoice.invoicenumber}-split`,
      },
      {
        headers: { Authorization: `Token ${auth.data.token}` },
        timeout: 15000,
      },
    );

    const paid = await db.query(
      `UPDATE invoice_payout_splits
          SET status = 'paid', paid_at = NOW(), updated_at = NOW(),
              campay_reference = $2, failure_reason = NULL
        WHERE id = $1
        RETURNING *`,
      [split.id, res.data?.reference ?? null],
    );
    logger.info("Invoice split payout sent", {
      invoiceNumber: invoice.invoicenumber,
      amount: split.amount,
    });
    sendSplitReceiptEmail(invoice, paid.rows[0]).catch((e) =>
      logger.warn("Split receipt email failed", { error: e.message }),
    );
    return { split: paid.rows[0], dispatched: true };
  } catch (err) {
    // A response from Campay means the request was refused and no money moved.
    // No response (timeout/network) is ambiguous, so it stays 'processing' for review.
    const definiteFailure = Boolean(err.response);
    const reason = String(
      err.response?.data?.message || err.message || "Unknown error",
    ).slice(0, 500);
    const failed = await db
      .query(
        `UPDATE invoice_payout_splits
            SET status = $2, failure_reason = $3, updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [split.id, definiteFailure ? "failed" : "processing", reason],
      )
      .catch(() => ({ rows: [split] }));
    logger.error("Invoice split payout failed", {
      invoiceNumber: invoice.invoicenumber,
      amount: split.amount,
      definiteFailure,
      error: reason,
    });
    return { split: failed.rows[0], dispatched: false };
  }
}

/**
 * Pay the split (if the invoice has one) and notify the API owner via webhook.
 * Used by release paths that do not return the split in their own response.
 * Never throws. `deliver` is deliverWebhookEvent from v1.js (passed in to avoid an import cycle).
 */
export async function settleInvoiceSplit(invoice, deliver) {
  try {
    const { split, dispatched } = await payInvoiceSplit(invoice);
    const pub = formatSplit(split);
    if (!pub) return null;
    const type =
      pub.status === "paid" && dispatched
        ? "payout.split_completed"
        : pub.status === "failed"
          ? "payout.split_failed"
          : null;
    if (type) {
      deliver(invoice.userid, type, {
        object: "event",
        type,
        invoice_id: invoice.invoicenumber,
        split: pub,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    }
    return pub;
  } catch (err) {
    logger.error("settleInvoiceSplit failed", {
      invoiceNumber: invoice.invoicenumber,
      error: err.message,
    });
    return null;
  }
}
