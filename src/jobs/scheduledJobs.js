/**
 * scheduledJobs.js
 *
 * Background jobs that run on a schedule:
 *
 *   1. Invoice payment reminders
 *      - 24 h after creation → first reminder to buyer
 *      - 48 h after creation → second reminder
 *      - 72 h after creation → final reminder
 *      Stops automatically once the invoice is no longer pending.
 *
 *   2. Dispute escalation
 *      - 72 h after dispute opened → warning email to admin
 *      - 7 days after dispute opened → strong escalation email to admin
 *
 * Both jobs use small tracking tables (auto-created on first boot) so the
 * same email is never sent twice even after a server restart.
 *
 * Both jobs run every hour so they never miss a window by more than 60 min.
 */

import cron from "node-cron";
import sgMail from "@sendgrid/mail";
import db from "../controllers/db.js";
import dotenv from "dotenv";
dotenv.config();

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ── Brand logo &mdash; inline SVG encoded as base64 for email clients ──────────────
const FONLOK_LOGO_B64 = Buffer.from(
  '<svg width="40" height="40" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<rect width="48" height="48" rx="11" fill="#0F1F3D"/>' +
    '<rect x="12.5" y="10" width="22.5" height="7.5" rx="3.75" fill="#F59E0B"/>' +
    '<rect x="12.5" y="21.5" width="15" height="5.5" rx="2.75" fill="#FFFFFF"/>' +
    '<rect x="12.5" y="10" width="6.5" height="27.5" rx="3" fill="#FFFFFF"/>' +
    "</svg>",
).toString("base64");

// ── Ensure tracking tables exist ─────────────────────────────────────────────

async function ensureTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS invoice_reminders (
      id            SERIAL PRIMARY KEY,
      invoicenumber TEXT        NOT NULL,
      reminder_level INTEGER    NOT NULL,  -- 1, 2, or 3
      sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (invoicenumber, reminder_level)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS dispute_escalations (
      id           SERIAL PRIMARY KEY,
      invoicenumber TEXT       NOT NULL,
      level        INTEGER     NOT NULL,  -- 1 = 72h warning, 2 = 7d escalation
      sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (invoicenumber, level)
    )
  `);
}

// ── Helper: hours since a timestamp ─────────────────────────────────────────

function hoursSince(ts) {
  return (Date.now() - new Date(ts).getTime()) / (1000 * 60 * 60);
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB 1 &mdash; Invoice payment reminders
// ─────────────────────────────────────────────────────────────────────────────

async function runInvoiceReminders() {
  try {
    // Find all buyer payment attempts where:
    //   - the buyer entered their email + phone (guests row exists)
    //   - the invoice is still unpaid (status = 'pending')
    //   - the attempt was made at least 23 h ago
    //   - the invoice hasn't expired yet
    //
    // The clock starts from guests.created_at &mdash; i.e. when the buyer tried to
    // pay &mdash; NOT from when the invoice was created. Reminders only make sense
    // after a payment attempt has been made and failed/timed out.
    const result = await db.query(`
      SELECT DISTINCT ON (g.invoicenumber)
             g.invoicenumber,
             g.email        AS buyer_email,
             g.created_at   AS attempt_at,
             i.invoicename,
             i.amount,
             i.currency,
             i.invoicelink
      FROM guests g
      JOIN invoices i ON i.invoicenumber = g.invoicenumber
      WHERE i.status   = 'pending'
        AND g.created_at < NOW() - INTERVAL '23 hours'
        AND (i.expires_at IS NULL OR i.expires_at > NOW())
      ORDER BY g.invoicenumber, g.created_at DESC
    `);

    for (const row of result.rows) {
      const hours = hoursSince(row.attempt_at);

      // Maximum 3 reminders, spaced 24 h apart from the payment attempt
      const levels = [];
      if (hours >= 24) levels.push(1);
      if (hours >= 48) levels.push(2);
      if (hours >= 72) levels.push(3);

      for (const level of levels) {
        // ── Atomic claim: INSERT first, send only if we own the row ─────────
        // With PM2 cluster mode multiple workers run this job concurrently.
        // A SELECT-then-INSERT check is not atomic &mdash; all workers can pass the
        // SELECT simultaneously and send the same email multiple times.
        // Instead we try the INSERT first. PostgreSQL's UNIQUE constraint
        // guarantees exactly one worker gets a RETURNING row; all others get
        // zero rows and skip without ever calling SendGrid.
        let claimed = false;
        try {
          const claimResult = await db.query(
            `INSERT INTO invoice_reminders (invoicenumber, reminder_level)
             VALUES ($1, $2)
             ON CONFLICT (invoicenumber, reminder_level) DO NOTHING
             RETURNING id`,
            [row.invoicenumber, level],
          );
          claimed = claimResult.rows.length > 0;
        } catch (claimErr) {
          console.error(
            `[Reminders] Claim error for ${row.invoicenumber} level ${level}:`,
            claimErr.message,
          );
          continue;
        }
        if (!claimed) continue; // another worker already owns this send

        const buyerEmail = row.buyer_email;
        const invoiceUrl =
          row.invoicelink ||
          `${process.env.FRONTEND_URL}/invoice/${row.invoicenumber}`;

        const subjects = [
          null,
          `Payment Reminder: Invoice Awaiting Payment  - ${row.invoicename}`,
          `Second Reminder: Payment Still Pending  - ${row.invoicename}`,
          `Final Notice: Invoice Expiring Soon  - ${row.invoicename}`,
        ];

        const intros = [
          null,
          "Just a friendly reminder that the following invoice is still awaiting your payment.",
          "We noticed the invoice below is still unpaid. The seller is waiting for your payment.",
          "This is a final reminder. If this invoice is not paid soon, it may expire and the seller will need to reissue it.",
        ];

        const buttonLabels = [
          null,
          "Pay Now",
          "Pay Invoice",
          "Pay Before It Expires",
        ];

        const urgencyColors = [null, "#0F1F3D", "#d97706", "#dc2626"];

        try {
          await sgMail.send({
            to: buyerEmail,
            from: process.env.VERIFIED_SENDER,
            subject: subjects[level],
            html: `
              <div style="font-family:sans-serif;max-width:560px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                <div style="background:#0F1F3D;padding:18px 24px;display:flex;align-items:center;">
                  <span style="display:inline-block;width:34px;height:34px;background:#F59E0B;border-radius:8px;text-align:center;line-height:34px;font-size:19px;font-weight:900;color:#0F1F3D;vertical-align:middle;margin-right:10px;font-family:Arial,sans-serif;">F</span>
                  <span style="color:#F59E0B;font-size:20px;font-weight:800;letter-spacing:-0.5px;vertical-align:middle;"><span style="color:#F59E0B;">F</span><span style="color:#ffffff;">onlok</span></span>
                  <span style="color:#94a3b8;font-size:12px;margin-left:12px;vertical-align:middle;">Secure Escrow Payments</span>
                </div>
                <div style="padding:24px;">
                  <h2 style="color:${urgencyColors[level]};margin:0 0 12px;">
                    ${level === 3 ? "⚠️ " : ""}${subjects[level]}
                  </h2>
                  <p style="color:#475569;">${intros[level]}</p>

                  <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f8fafc;border-radius:6px;">
                    <tr>
                      <td style="padding:10px 14px;font-weight:600;color:#64748b;font-size:13px;">Invoice</td>
                      <td style="padding:10px 14px;color:#0f172a;">${row.invoicename}</td>
                    </tr>
                    <tr style="background:#f1f5f9;">
                      <td style="padding:10px 14px;font-weight:600;color:#64748b;font-size:13px;">Reference</td>
                      <td style="padding:10px 14px;color:#0f172a;font-family:monospace;">${row.invoicenumber}</td>
                    </tr>
                    <tr>
                      <td style="padding:10px 14px;font-weight:600;color:#64748b;font-size:13px;">Amount Due</td>
                      <td style="padding:10px 14px;font-weight:700;color:#16a34a;font-size:15px;">${Number(row.amount).toLocaleString()} ${row.currency && row.currency !== "USD" ? row.currency : "XAF"}</td>
                    </tr>
                  </table>

                  <a href="${invoiceUrl}"
                    style="display:inline-block;background:#F59E0B;color:#0F1F3D;padding:13px 28px;text-decoration:none;border-radius:7px;font-weight:700;font-size:15px;margin:8px 0 20px;">
                    ${buttonLabels[level]} →
                  </a>

                  <p style="color:#94a3b8;font-size:12px;border-top:1px solid #e2e8f0;padding-top:16px;margin-top:16px;">
                    You received this email because a seller sent you an invoice through Fonlok.
                    If you did not request this, you can safely ignore this message.
                  </p>
                </div>
              </div>
            `,
          });

          // Record that this reminder was sent
          // (row already inserted atomically above &mdash; nothing more to do here)

          console.log(
            `📧 [Reminders] Level ${level} sent for ${row.invoicenumber} → ${buyerEmail}`,
          );
        } catch (emailErr) {
          // Email failed &mdash; delete the claim so the next run can retry
          try {
            await db.query(
              "DELETE FROM invoice_reminders WHERE invoicenumber = $1 AND reminder_level = $2",
              [row.invoicenumber, level],
            );
          } catch (_) {
            /* ignore cleanup error */
          }
          console.error(
            `❌ [Reminders] Failed to send level ${level} for ${row.invoicenumber}:`,
            emailErr.response?.body || emailErr.message,
          );
        }
      }
    }

    console.log(
      `⏰ [Reminders] Checked ${result.rows.length} pending invoice(s)`,
    );
  } catch (err) {
    console.error("❌ [Reminders] Job error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB 2 &mdash; Dispute escalation
// ─────────────────────────────────────────────────────────────────────────────

async function runDisputeEscalation() {
  try {
    // Find all disputes that are still open
    const result = await db.query(`
      SELECT d.invoicenumber, d.opened_by, d.reason, d.admin_token, d.created_at,
             i.invoicename, i.amount, i.currency
      FROM disputes d
      JOIN invoices i ON i.invoicenumber = d.invoicenumber
      WHERE d.status = 'open'
    `);

    for (const dispute of result.rows) {
      const hours = hoursSince(dispute.created_at);

      const adminUrl = `${process.env.FRONTEND_URL}/admin/dispute/${dispute.admin_token}`;
      const openedDate = new Date(dispute.created_at).toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      // Level 1: 72-hour warning
      if (hours >= 72) {
        const already = await db.query(
          "SELECT 1 FROM dispute_escalations WHERE invoicenumber = $1 AND level = 1",
          [dispute.invoicenumber],
        );
        if (already.rows.length === 0) {
          try {
            await sgMail.send({
              to: process.env.ADMIN_EMAIL,
              from: process.env.VERIFIED_SENDER,
              subject: `[Admin Alert] Dispute Unresolved: 72 Hours Elapsed  - Invoice ${dispute.invoicenumber}`,
              html: `
                <div style="font-family:sans-serif;max-width:560px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                  <div style="background:#0F1F3D;padding:18px 24px;line-height:1;">
                    <span style="display:inline-block;width:34px;height:34px;background:#F59E0B;border-radius:8px;text-align:center;line-height:34px;font-size:19px;font-weight:900;color:#0F1F3D;vertical-align:middle;margin-right:10px;font-family:Arial,sans-serif;">F</span>
                    <span style="font-size:20px;font-weight:800;letter-spacing:-0.5px;vertical-align:middle;"><span style="color:#F59E0B;">F</span><span style="color:#ffffff;">onlok</span></span>
                    <span style="color:#94a3b8;font-size:12px;margin-left:12px;vertical-align:middle;">Admin Alert</span>
                  </div>
                  <div style="padding:24px;">
                    <div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:14px;margin-bottom:20px;">
                      <strong style="color:#92400e;">⏰ Reminder:</strong>
                      <span style="color:#78350f;"> This dispute has been open for over 72 hours without resolution.</span>
                    </div>

                    <h2 style="color:#0F1F3D;margin:0 0 16px;">Dispute Awaiting Your Review</h2>

                    <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:6px;margin-bottom:20px;">
                      <tr>
                        <td style="padding:10px 14px;font-weight:600;color:#64748b;font-size:13px;">Invoice</td>
                        <td style="padding:10px 14px;color:#0f172a;">${dispute.invoicenumber}</td>
                      </tr>
                      <tr style="background:#f1f5f9;">
                        <td style="padding:10px 14px;font-weight:600;color:#64748b;font-size:13px;">Invoice Name</td>
                        <td style="padding:10px 14px;color:#0f172a;">${dispute.invoicename}</td>
                      </tr>
                      <tr>
                        <td style="padding:10px 14px;font-weight:600;color:#64748b;font-size:13px;">Amount</td>
                        <td style="padding:10px 14px;font-weight:700;color:#0f172a;">${Number(dispute.amount).toLocaleString()} ${dispute.currency}</td>
                      </tr>
                      <tr style="background:#f1f5f9;">
                        <td style="padding:10px 14px;font-weight:600;color:#64748b;font-size:13px;">Opened By</td>
                        <td style="padding:10px 14px;color:#0f172a;">${dispute.opened_by}</td>
                      </tr>
                      <tr>
                        <td style="padding:10px 14px;font-weight:600;color:#64748b;font-size:13px;">Reason</td>
                        <td style="padding:10px 14px;color:#0f172a;">${dispute.reason}</td>
                      </tr>
                      <tr style="background:#f1f5f9;">
                        <td style="padding:10px 14px;font-weight:600;color:#64748b;font-size:13px;">Opened At</td>
                        <td style="padding:10px 14px;color:#0f172a;">${openedDate}</td>
                      </tr>
                    </table>

                    <a href="${adminUrl}"
                      style="display:inline-block;background:#0F1F3D;color:#F59E0B;padding:13px 28px;text-decoration:none;border-radius:7px;font-weight:700;font-size:15px;">
                      Open Admin Panel →
                    </a>
                  </div>
                </div>
              `,
            });

            await db.query(
              "INSERT INTO dispute_escalations (invoicenumber, level) VALUES ($1, 1) ON CONFLICT DO NOTHING",
              [dispute.invoicenumber],
            );

            console.log(
              `📧 [Disputes] 72h warning sent for ${dispute.invoicenumber}`,
            );
          } catch (emailErr) {
            console.error(
              `❌ [Disputes] 72h email failed for ${dispute.invoicenumber}:`,
              emailErr.response?.body || emailErr.message,
            );
          }
        }
      }

      // Level 2: 7-day critical escalation
      if (hours >= 168) {
        const already = await db.query(
          "SELECT 1 FROM dispute_escalations WHERE invoicenumber = $1 AND level = 2",
          [dispute.invoicenumber],
        );
        if (already.rows.length === 0) {
          try {
            await sgMail.send({
              to: process.env.ADMIN_EMAIL,
              from: process.env.VERIFIED_SENDER,
              subject: `[URGENT] Dispute Unresolved: 7 Days  - Immediate Action Required for Invoice ${dispute.invoicenumber}`,
              html: `
                <div style="font-family:sans-serif;max-width:560px;border:2px solid #dc2626;border-radius:8px;overflow:hidden;">
                  <div style="background:#dc2626;padding:18px 24px;line-height:1;">
                    <span style="display:inline-block;width:34px;height:34px;background:#FDE68A;border-radius:8px;text-align:center;line-height:34px;font-size:19px;font-weight:900;color:#7f1d1d;vertical-align:middle;margin-right:10px;font-family:Arial,sans-serif;">F</span>
                    <span style="font-size:20px;font-weight:800;letter-spacing:-0.5px;vertical-align:middle;"><span style="color:#FDE68A;">F</span><span style="color:#ffffff;">onlok</span></span>
                    <span style="color:#fecaca;font-size:12px;margin-left:12px;vertical-align:middle;">URGENT Admin Alert</span>
                  </div>
                  <div style="padding:24px;">
                    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:14px;margin-bottom:20px;">
                      <strong style="color:#991b1b;">CRITICAL:</strong>
                      <span style="color:#7f1d1d;"> This dispute has been open for <strong>7 days</strong> with no resolution. Both parties are waiting. Immediate action is required.</span>
                    </div>

                    <h2 style="color:#dc2626;margin:0 0 16px;">Dispute &mdash; 7 Days Unresolved</h2>

                    <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:6px;margin-bottom:20px;">
                      <tr>
                        <td style="padding:10px 14px;font-weight:600;color:#64748b;font-size:13px;">Invoice</td>
                        <td style="padding:10px 14px;color:#0f172a;">${dispute.invoicenumber}</td>
                      </tr>
                      <tr style="background:#f1f5f9;">
                        <td style="padding:10px 14px;font-weight:600;color:#64748b;font-size:13px;">Invoice Name</td>
                        <td style="padding:10px 14px;color:#0f172a;">${dispute.invoicename}</td>
                      </tr>
                      <tr>
                        <td style="padding:10px 14px;font-weight:600;color:#64748b;font-size:13px;">Amount at Stake</td>
                        <td style="padding:10px 14px;font-weight:700;color:#dc2626;font-size:15px;">${Number(dispute.amount).toLocaleString()} ${dispute.currency}</td>
                      </tr>
                      <tr style="background:#f1f5f9;">
                        <td style="padding:10px 14px;font-weight:600;color:#64748b;font-size:13px;">Opened By</td>
                        <td style="padding:10px 14px;color:#0f172a;">${dispute.opened_by}</td>
                      </tr>
                      <tr>
                        <td style="padding:10px 14px;font-weight:600;color:#64748b;font-size:13px;">Reason</td>
                        <td style="padding:10px 14px;color:#0f172a;">${dispute.reason}</td>
                      </tr>
                      <tr style="background:#fef2f2;">
                        <td style="padding:10px 14px;font-weight:600;color:#64748b;font-size:13px;">Opened At</td>
                        <td style="padding:10px 14px;color:#991b1b;font-weight:700;">${openedDate}</td>
                      </tr>
                    </table>

                    <a href="${adminUrl}"
                      style="display:inline-block;background:#dc2626;color:#fff;padding:14px 32px;text-decoration:none;border-radius:7px;font-weight:700;font-size:16px;">
                      Resolve This Dispute Now →
                    </a>

                    <p style="color:#94a3b8;font-size:12px;margin-top:20px;">
                      This is an automated critical alert from Fonlok. Please resolve this dispute immediately.
                    </p>
                  </div>
                </div>
              `,
            });

            await db.query(
              "INSERT INTO dispute_escalations (invoicenumber, level) VALUES ($1, 2) ON CONFLICT DO NOTHING",
              [dispute.invoicenumber],
            );

            console.log(
              `📧 [Disputes] 7-day critical escalation sent for ${dispute.invoicenumber}`,
            );
          } catch (emailErr) {
            console.error(
              `❌ [Disputes] 7-day email failed for ${dispute.invoicenumber}:`,
              emailErr.response?.body || emailErr.message,
            );
          }
        }
      }
    }

    console.log(`⏰ [Disputes] Checked ${result.rows.length} open dispute(s)`);
  } catch (err) {
    console.error("❌ [Disputes] Job error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Export: call this once when the server starts
// ─────────────────────────────────────────────────────────────────────────────

export async function startScheduledJobs() {
  // ── Only run on PM2 worker 0 (or when not under PM2 at all) ─────────────
  // In cluster mode PM2 spawns one process per CPU core. Without this guard
  // every worker would run the cron independently, sending each email N times
  // (one per core). NODE_APP_INSTANCE is set by PM2; instance 0 is the leader.
  const instanceId = parseInt(process.env.NODE_APP_INSTANCE ?? "0", 10);
  if (instanceId !== 0) {
    console.log(
      `⏭️  Scheduled jobs skipped on PM2 worker ${instanceId} (only runs on worker 0)`,
    );
    return;
  }

  // Make sure the tracking tables exist before any job runs
  await ensureTables();
  console.log("✅ Scheduled job tracking tables ready");

  // Run both jobs immediately on boot so nothing is missed if the server was
  // down for a while, then schedule them to run every hour after that.
  await runInvoiceReminders();
  await runDisputeEscalation();

  // Every hour at minute 0  (e.g. 09:00, 10:00, 11:00 …)
  cron.schedule("0 * * * *", async () => {
    await runInvoiceReminders();
    await runDisputeEscalation();
  });

  console.log(
    "⏰ Scheduled jobs active &mdash; invoice reminders + dispute escalation",
  );
}
