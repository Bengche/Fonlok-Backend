/**
 * paymentParts.js — part payments for invoices above the mobile money limit.
 *
 * Mobile money collections above ~500,000 XAF are likely to fail, so an invoice
 * above MAX_PAYMENT_PART is collected in equal parts of at most that size. The
 * plan is derived from the invoice amount alone and progress is derived from the
 * 'paid' rows in payments, so there is no extra state to keep in sync.
 *
 * Invoices at or below the limit never use this module's code paths.
 */

import db from "../controllers/db.js";

export const MAX_PAYMENT_PART =
  Number(process.env.MAX_PAYMENT_PART_XAF) || 500000;

// A pending prompt younger than this blocks a second prompt for the same invoice.
export const PART_PROMPT_WINDOW_SECONDS = 120;

export function requiresPartPayments(amount) {
  return Math.round(Number(amount)) > MAX_PAYMENT_PART;
}

/** Equal parts, each at most MAX_PAYMENT_PART; the remainder is spread over the first parts. */
export function planPaymentParts(amount, max = MAX_PAYMENT_PART) {
  const total = Math.round(Number(amount));
  const count = Math.max(1, Math.ceil(total / max));
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from(
    { length: count },
    (_, i) => base + (i < remainder ? 1 : 0),
  );
}

/** Pure progress calculation from the plan and what has been collected so far. */
export function computeProgress(amount, paidParts, paidAmount) {
  const total = Math.round(Number(amount));
  const parts = planPaymentParts(total);
  const paid = Number(paidAmount) || 0;
  const remaining = Math.max(0, total - paid);
  const done = paid >= total;
  const nextPartNumber = done ? null : Math.min(paidParts + 1, parts.length);
  // Never ask for more than what is still owed.
  const nextPartAmount = done
    ? 0
    : Math.min(parts[Math.min(paidParts, parts.length - 1)], remaining);
  return {
    total_amount: total,
    part_count: parts.length,
    parts,
    paid_parts: paidParts,
    paid_amount: paid,
    remaining_amount: remaining,
    next_part_number: nextPartNumber,
    next_part_amount: nextPartAmount,
    complete: done,
  };
}

/** Progress for an invoice, from the payments table. Returns null for single-payment invoices. */
export async function getPaymentProgress(invoice, client = db) {
  if (!requiresPartPayments(invoice.amount)) return null;
  const sums = await client.query(
    `SELECT COUNT(*)::int AS parts, COALESCE(SUM(amount), 0) AS paid
       FROM payments WHERE invoiceid = $1 AND status = 'paid'`,
    [invoice.id],
  );
  return computeProgress(invoice.amount, sums.rows[0].parts, sums.rows[0].paid);
}

/** True when a prompt for this invoice was sent moments ago and has not been resolved. */
export async function hasRecentPendingPrompt(invoiceId) {
  const res = await db.query(
    `SELECT 1 FROM payments
      WHERE invoiceid = $1 AND status = 'pending'
        AND createdat > NOW() - ($2 || ' seconds')::interval
      LIMIT 1`,
    [invoiceId, String(PART_PROMPT_WINDOW_SECONDS)],
  );
  return res.rows.length > 0;
}

/**
 * Record a confirmed part inside a locked transaction so concurrent confirmations
 * for the same invoice are serialised and exactly one of them observes completion.
 * Marks the payment paid and moves the invoice to 'partially_paid' when money is
 * still owed; on completion the caller continues with the normal 'paid' flow.
 */
export async function recordConfirmedPart(invoiceId, paymentUUID) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const inv = await client.query(
      "SELECT id, amount, status FROM invoices WHERE id = $1 FOR UPDATE",
      [invoiceId],
    );
    await client.query(
      "UPDATE payments SET status = 'paid' WHERE providerpaymentid = $1",
      [paymentUUID],
    );
    const progress = await getPaymentProgress(inv.rows[0], client);
    if (!progress.complete) {
      await client.query(
        "UPDATE invoices SET status = 'partially_paid' WHERE id = $1 AND status IN ('pending', 'partially_paid')",
        [invoiceId],
      );
    }
    await client.query("COMMIT");
    return progress;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
