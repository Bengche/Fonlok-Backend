import express from "express";
const router = express.Router();
import axios from "axios";
import dotenv from "dotenv";
import db from "../controllers/db.js";
import sgMail from "@sendgrid/mail";
import { notifyUser } from "../middleware/notificationHelper.js";
import { emailWrap, emailTable, emailButton } from "../utils/emailTemplate.js";
import { generateReceiptPdf } from "../utils/generateReceipt.js";
import authMiddleware from "../middleware/authMiddleware.js";
dotenv.config();

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// --- THE SHARED PAYOUT FUNCTION (Core Logic) ---
// ─────────────────────────────────────────────────────────────────────────────
// FEE CONSTANTS
//
// When a referral is involved:
//   Fonlok keeps 1.5%  (PLATFORM_FEE_RATE)
//   Referrer earns 0.5% (REFERRAL_FEE_RATE)
//   Total deducted from gross: exactly 2%
//
// When there is no referral:
//   Fonlok keeps the full 2% (PLATFORM_FEE_RATE + REFERRAL_FEE_RATE)
//
// In both cases the seller always receives gross − 2%.  The only difference is
// where the 0.5% portion goes when a referrer exists.
// ─────────────────────────────────────────────────────────────────────────────
const PLATFORM_FEE_RATE = 0.015; // 1.5% &mdash; Fonlok's cut
const REFERRAL_FEE_RATE = 0.005; // 0.5% &mdash; referrer's cut (only when referral exists)
const TOTAL_FEE_RATE = 0.02; // 2.0% &mdash; always deducted from seller payout

// ─────────────────────────────────────────────────────────────────────────────
// renderPage({ type, title, body, ctaHref?, ctaLabel?, warningBox?, note? })
//
// Generates a consistent, branded HTML page for all server-rendered buyer-
// facing confirmation and status screens (fund release, error pages, etc.).
// type: "success" | "error" | "warning" | "info"
// ─────────────────────────────────────────────────────────────────────────────
function renderPage({ type = "info", title, body, ctaHref, ctaLabel, formAction, formLabel, warningBox, note } = {}) {
  const palette = {
    success: { accent: "#16a34a", bg: "#f0fdf4", icon: "✓" },
    error:   { accent: "#dc2626", bg: "#fef2f2", icon: "✗" },
    warning: { accent: "#d97706", bg: "#fffbeb", icon: "⚠" },
    info:    { accent: "#0F1F3D", bg: "#f8fafc", icon: "i" },
  };
  const { accent, bg, icon } = palette[type] ?? palette.info;
  const warnHtml = warningBox
    ? `<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:14px 16px;margin:20px 0;color:#9a3412;font-size:14px;line-height:1.6;text-align:left;">${warningBox}</div>`
    : "";
  const ctaHtml = ctaHref
    ? `<a href="${ctaHref}" style="display:block;margin-top:24px;padding:14px 20px;background:#15803d;color:#fff;border-radius:8px;font-size:15px;font-weight:600;text-decoration:none;text-align:center;">${ctaLabel || "Continue"}</a>`
    : "";
  const formHtml = formAction
    ? `<form method="POST" action="${formAction}" style="margin-top:24px;">
        <button type="submit" style="display:block;width:100%;padding:14px 20px;background:#15803d;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;">${formLabel || "Confirm"}</button>
       </form>`
    : "";
  const noteHtml = note
    ? `<p style="color:#94a3b8;font-size:13px;margin-top:28px;line-height:1.6;">${note}</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — Fonlok</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:${bg};min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
    .logo{background:#0F1F3D;width:52px;height:52px;border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto 20px}
    .logo span{color:#F59E0B;font-size:24px;font-weight:900;line-height:1}
    .card{background:#fff;border-radius:14px;box-shadow:0 1px 4px rgba(0,0,0,.08),0 6px 24px rgba(0,0,0,.06);padding:40px 36px;max-width:480px;width:100%;text-align:center}
    .icon-ring{width:60px;height:60px;border-radius:50%;background:${accent}1a;border:2px solid ${accent}33;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:28px;color:${accent};font-weight:700}
    h1{color:#0F1F3D;font-size:22px;font-weight:700;margin-bottom:10px}
    .body-txt{color:#475569;line-height:1.65;font-size:15px}
    @media(max-width:520px){.card{padding:28px 18px}h1{font-size:20px}}
  </style>
</head>
<body>
  <div class="logo"><span>F</span></div>
  <div class="card">
    <div class="icon-ring">${icon}</div>
    <h1>${title}</h1>
    <div class="body-txt">${body}</div>
    ${warnHtml}
    ${formHtml}
    ${ctaHtml}
    ${noteHtml}
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// executePayout(invoiceId)
// Shared core for Method 1 (code-based release).
// invoiceId = invoices.id (the numeric primary key)
//
// RACE-CONDITION PROTECTION
// The very first database operation is an atomic UPDATE that flips is_used to
// true only when it is currently false.  If two concurrent requests both reach
// this point at the same time, exactly one will get a RETURNING row and
// proceed; the other gets zero rows and throws immediately &mdash; before any money
// moves.  This eliminates the TOCTOU window that previously existed between
// the "already paid?" read and the "mark as paid" write.
// ─────────────────────────────────────────────────────────────────────────────
const executePayout = async (invoiceId) => {
  // ── Step 1: Atomically claim the payout slot ─────────────────────────────
  // UPDATE returns the row only when is_used was false; any concurrent request
  // finds is_used already true and gets back zero rows → throws before Campay.
  const lockResult = await db.query(
    `UPDATE confirmation_codes
        SET is_used = true
      WHERE code_id = $1
        AND is_used  = false
      RETURNING code_id`,
    [invoiceId],
  );
  if (lockResult.rows.length === 0) {
    throw new Error(
      `Payout for invoice id ${invoiceId} has already been processed or the confirmation code was not found.`,
    );
  }

  // ── Step 2: Fetch invoice & seller ──────────────────────────────────────
  const invoiceRes = await db.query("SELECT * FROM invoices WHERE id = $1", [
    invoiceId,
  ]);
  if (invoiceRes.rows.length === 0) throw new Error("Invoice not found");
  const invoiceRow = invoiceRes.rows[0];
  const sellerId = invoiceRow.userid;
  const grossAmount = Number(invoiceRow.amount);

  const userResult = await db.query("SELECT * FROM users WHERE id = $1", [
    sellerId,
  ]);
  if (userResult.rows.length === 0) throw new Error("Seller account not found");
  const invoiceUser = userResult.rows[0];

  // ── Step 3: Determine referral and calculate fees ────────────────────────
  // Check for a referrer BEFORE computing fees so the correct split is used.
  const referrerCheck = await db.query(
    "SELECT referred_by FROM users WHERE id = $1",
    [sellerId],
  );
  const referrerId = referrerCheck.rows[0]?.referred_by ?? null;
  const hasReferral = referrerId !== null;

  // Seller always receives gross − 2%.  When a referrer exists, Fonlok keeps
  // only 1.5% and the 0.5% remainder goes to the referrer.
  const totalFee = Math.floor(grossAmount * TOTAL_FEE_RATE); // 2%
  const referralEarning = hasReferral
    ? Math.floor(grossAmount * REFERRAL_FEE_RATE) // 0.5%
    : 0;
  const fonlokNet = totalFee - referralEarning; // 1.5% or 2%
  const sellerReceives = grossAmount - totalFee; // always gross − 2%

  console.log(
    `Invoice ${invoiceRow.invoicenumber}: gross=${grossAmount}, ` +
      `totalFee=${totalFee}, fonlokNet=${fonlokNet}, ` +
      `referralEarning=${referralEarning}, sellerReceives=${sellerReceives}`,
  );

  // ── Step 4: Transfer to seller via Campay ───────────────────────────────
  const auth = await axios.post(`${process.env.CAMPAY_BASE_URL}token/`, {
    username: process.env.CAMPAY_USERNAME,
    password: process.env.CAMPAY_PASSWORD,
  });

  await axios.post(
    `${process.env.CAMPAY_BASE_URL}withdraw/`,
    {
      amount: sellerReceives.toString(),
      currency: "XAF",
      to: invoiceUser.phone,
      description: `Fonlok payout for invoice ${invoiceRow.invoicenumber}`,
      external_reference: invoiceRow.invoicenumber,
    },
    { headers: { Authorization: `Token ${auth.data.token}` } },
  );

  // ── Step 5: Record the payout & mark invoice completed ─────────────────
  await db.query(
    "INSERT INTO payouts (userid, amount, method, status, invoice_id, invoice_number) VALUES ($1, $2, $3, $4, $5, $6)",
    [
      sellerId,
      sellerReceives,
      "Mobile Money",
      "paid",
      invoiceId,
      invoiceRow.invoicenumber,
    ],
  );
  // Mark the invoice as completed so any subsequent release attempt gets a
  // clean, informative error at the route layer before it ever reaches the
  // atomic confirmation_codes lock.
  await db.query("UPDATE invoices SET status = 'completed' WHERE id = $1", [
    invoiceId,
  ]);

  // ── Step 6: Notify the seller ────────────────────────────────────────────
  notifyUser(
    sellerId,
    "payout_sent",
    "Payout Sent",
    `${sellerReceives} XAF has been sent to your Mobile Money account for invoice ${invoiceRow.invoicenumber}.`,
    { amount: sellerReceives, invoiceNumber: invoiceRow.invoicenumber },
  );

  // ── Step 7: Credit referral earnings &mdash; INSERT first, balance only if new ──
  // The earnings row is the single source of truth.  INSERT with RETURNING
  // tells us whether a genuinely new row was written (vs a conflict/no-op).
  // The balance UPDATE only runs when a new row was actually inserted, so a
  // retry or concurrent duplicate request can NEVER double-credit the referrer.
  if (hasReferral && referralEarning > 0) {
    try {
      const earningsInsert = await db.query(
        `INSERT INTO referral_earnings
           (referrer_userid, referred_userid, invoice_number, invoice_amount, earned_amount)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (invoice_number) DO NOTHING
         RETURNING id`,
        [
          referrerId,
          sellerId,
          invoiceRow.invoicenumber,
          grossAmount,
          referralEarning,
        ],
      );
      if (earningsInsert.rows.length > 0) {
        await db.query(
          "UPDATE users SET referral_balance = referral_balance + $1 WHERE id = $2",
          [referralEarning, referrerId],
        );
        console.log(
          `✅ Referral earning of ${referralEarning} XAF (0.5%) credited to user ${referrerId}. ` +
            `Fonlok net fee: ${fonlokNet} XAF (1.5%).`,
        );
      } else {
        console.log(
          `ℹ️ Referral earnings for invoice ${invoiceRow.invoicenumber} already recorded &mdash; balance not double-credited.`,
        );
      }
    } catch (referralErr) {
      console.error(
        "⚠️ Referral credit error (payout still succeeded):",
        referralErr.message,
      );
    }
  }

  // ── Step 8: Send PDF receipt to seller ──────────────────────────────────
  let sellerPdfAttachment = null;
  try {
    const pdfBuffer = await generateReceiptPdf(invoiceRow.invoicenumber);
    sellerPdfAttachment = {
      content: pdfBuffer.toString("base64"),
      filename: `fonlok-receipt-${invoiceRow.invoicenumber}.pdf`,
      type: "application/pdf",
      disposition: "attachment",
    };
  } catch (pdfErr) {
    console.error("⚠️ Could not generate seller receipt PDF:", pdfErr.message);
  }

  const feeLabel = hasReferral ? "Fonlok Fee (1.5%)" : "Fonlok Fee (2%)";
  const sellerReceiptDownloadLink = `${process.env.BACKEND_URL}/invoice/receipt/${invoiceRow.invoicenumber}`;
  const sellerReceiptMsg = {
    to: invoiceUser.email,
    from: process.env.VERIFIED_SENDER,
    subject: `Payout Confirmed  - Invoice ${invoiceRow.invoicenumber} | Fonlok`,
    html: emailWrap(
      `<h2 style="color:#0F1F3D;margin:0 0 12px;">Payout Confirmed &mdash; Funds Sent</h2>
      <p style="color:#475569;">Hello ${invoiceUser.name}, the buyer has confirmed delivery and your funds have been transferred to your Mobile Money account.</p>
      ${emailTable([
        ["Invoice Number", invoiceRow.invoicenumber],
        ["Invoice Name", invoiceRow.invoicename],
        ["Gross Amount", `${grossAmount} XAF`],
        [feeLabel, `−${totalFee} XAF`, "color:#dc2626;"],
        [
          "Amount Sent",
          `${sellerReceives} XAF`,
          "font-weight:700;color:#16a34a;font-size:15px;",
        ],
        ["Sent To", invoiceUser.phone],
        ["Status", "&#10003;&nbsp;Paid Out", "color:#16a34a;font-weight:600;"],
      ])}
      <p style="color:#475569;margin-top:12px;">Your official payout receipt is attached to this email as a PDF. You can also download it at any time using the button below.</p>
      ${emailButton(sellerReceiptDownloadLink, "Download PDF Receipt")}`,
      {
        footerNote:
          "Thank you for using Fonlok. This email confirms your payout has been processed. Please keep this receipt for your records.",
      },
    ),
    ...(sellerPdfAttachment ? { attachments: [sellerPdfAttachment] } : {}),
  };

  try {
    await sgMail.send(sellerReceiptMsg);
    console.log("✅ Seller receipt email sent.");
  } catch (emailErr) {
    console.error(
      "❌ Seller Receipt Email Error:",
      emailErr.response ? emailErr.response.body : emailErr.message,
    );
  }

  return true;
};

// FUNCTION WITH LINK

// ─────────────────────────────────────────────────────────────────────────────
// executePayoutLink(invoiceId)
// Shared core for Method 2 (email-link release).
//
// invoiceId is the confirmation_codes.code_id value obtained from the token
// row &mdash; validated by the calling route BEFORE this function is invoked, so we
// know it is the correct invoice for this token.
//
// RACE-CONDITION PROTECTION: identical atomic-lock pattern to executePayout.
// ─────────────────────────────────────────────────────────────────────────────
const executePayoutLink = async (invoiceId) => {
  // ── Step 1: Atomically claim the payout slot ─────────────────────────────
  const lockResult = await db.query(
    `UPDATE confirmation_codes
        SET is_used = true
      WHERE code_id = $1
        AND is_used  = false
      RETURNING code_id`,
    [invoiceId],
  );
  if (lockResult.rows.length === 0) {
    throw new Error(
      `Payout for invoice id ${invoiceId} has already been processed or the confirmation code was not found.`,
    );
  }

  // ── Step 2: Fetch invoice & seller ──────────────────────────────────────
  const invoiceRes = await db.query("SELECT * FROM invoices WHERE id = $1", [
    invoiceId,
  ]);
  if (!invoiceRes.rows[0]) throw new Error("Invoice not found");
  const invoiceRow = invoiceRes.rows[0];
  const sellerId = invoiceRow.userid;
  const grossAmount = Number(invoiceRow.amount);

  const userResult = await db.query("SELECT * FROM users WHERE id = $1", [
    sellerId,
  ]);
  if (userResult.rows.length === 0) throw new Error("Seller account not found");
  const invoiceUser = userResult.rows[0];

  // ── Step 3: Determine referral and calculate fees ────────────────────────
  const referrerCheck = await db.query(
    "SELECT referred_by FROM users WHERE id = $1",
    [sellerId],
  );
  const referrerId = referrerCheck.rows[0]?.referred_by ?? null;
  const hasReferral = referrerId !== null;

  const totalFee = Math.floor(grossAmount * TOTAL_FEE_RATE); // 2%
  const referralEarning = hasReferral
    ? Math.floor(grossAmount * REFERRAL_FEE_RATE) // 0.5%
    : 0;
  const fonlokNet = totalFee - referralEarning; // 1.5% or 2%
  const sellerReceives = grossAmount - totalFee; // gross − 2%

  console.log(
    `Invoice ${invoiceRow.invoicenumber}: gross=${grossAmount}, ` +
      `totalFee=${totalFee}, fonlokNet=${fonlokNet}, ` +
      `referralEarning=${referralEarning}, sellerReceives=${sellerReceives}`,
  );

  // ── Step 4: Transfer to seller via Campay ───────────────────────────────
  const auth = await axios.post(`${process.env.CAMPAY_BASE_URL}token/`, {
    username: process.env.CAMPAY_USERNAME,
    password: process.env.CAMPAY_PASSWORD,
  });

  await axios.post(
    `${process.env.CAMPAY_BASE_URL}withdraw/`,
    {
      amount: sellerReceives.toString(),
      currency: "XAF",
      to: invoiceUser.phone,
      description: `Fonlok payout for invoice ${invoiceRow.invoicenumber}`,
      external_reference: invoiceRow.invoicenumber,
    },
    { headers: { Authorization: `Token ${auth.data.token}` } },
  );

  // ── Step 5: Record the payout & mark invoice completed ─────────────────
  await db.query(
    "INSERT INTO payouts (userid, amount, method, status, invoice_id, invoice_number) VALUES ($1, $2, $3, $4, $5, $6)",
    [
      sellerId,
      sellerReceives,
      "Mobile Money",
      "paid",
      invoiceId,
      invoiceRow.invoicenumber,
    ],
  );
  await db.query("UPDATE invoices SET status = 'completed' WHERE id = $1", [
    invoiceId,
  ]);

  // ── Step 6: Notify the seller ────────────────────────────────────────────
  notifyUser(
    sellerId,
    "payout_sent",
    "Payout Sent",
    `${sellerReceives} XAF has been sent to your Mobile Money account for invoice ${invoiceRow.invoicenumber}.`,
    { amount: sellerReceives, invoiceNumber: invoiceRow.invoicenumber },
  );

  // ── Step 7: Credit referral earnings &mdash; INSERT first, balance only if new ──
  if (hasReferral && referralEarning > 0) {
    try {
      const earningsInsert = await db.query(
        `INSERT INTO referral_earnings
           (referrer_userid, referred_userid, invoice_number, invoice_amount, earned_amount)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (invoice_number) DO NOTHING
         RETURNING id`,
        [
          referrerId,
          sellerId,
          invoiceRow.invoicenumber,
          grossAmount,
          referralEarning,
        ],
      );
      if (earningsInsert.rows.length > 0) {
        await db.query(
          "UPDATE users SET referral_balance = referral_balance + $1 WHERE id = $2",
          [referralEarning, referrerId],
        );
        console.log(
          `✅ Referral earning of ${referralEarning} XAF (0.5%) credited to user ${referrerId}. ` +
            `Fonlok net fee: ${fonlokNet} XAF (1.5%).`,
        );
      } else {
        console.log(
          `ℹ️ Referral earnings for invoice ${invoiceRow.invoicenumber} already recorded &mdash; balance not double-credited.`,
        );
      }
    } catch (referralErr) {
      console.error(
        "⚠️ Referral credit error (payout still succeeded):",
        referralErr.message,
      );
    }
  }

  // ── Step 8: Send PDF receipt to seller ──────────────────────────────────
  let sellerPdfAttachment = null;
  try {
    const pdfBuffer = await generateReceiptPdf(invoiceRow.invoicenumber);
    sellerPdfAttachment = {
      content: pdfBuffer.toString("base64"),
      filename: `fonlok-receipt-${invoiceRow.invoicenumber}.pdf`,
      type: "application/pdf",
      disposition: "attachment",
    };
  } catch (pdfErr) {
    console.error("⚠️ Could not generate seller receipt PDF:", pdfErr.message);
  }

  const feeLabel = hasReferral ? "Fonlok Fee (1.5%)" : "Fonlok Fee (2%)";
  const sellerReceiptDownloadLink = `${process.env.BACKEND_URL}/invoice/receipt/${invoiceRow.invoicenumber}`;
  const sellerReceiptMsg = {
    to: invoiceUser.email,
    from: process.env.VERIFIED_SENDER,
    subject: `Payout Confirmed  - Invoice ${invoiceRow.invoicenumber} | Fonlok`,
    html: emailWrap(
      `<h2 style="color:#0F1F3D;margin:0 0 12px;">Payout Confirmed &mdash; Funds Sent</h2>
      <p style="color:#475569;">Hello ${invoiceUser.name}, the buyer has confirmed delivery and your funds have been transferred to your Mobile Money account.</p>
      ${emailTable([
        ["Invoice Number", invoiceRow.invoicenumber],
        ["Invoice Name", invoiceRow.invoicename],
        ["Gross Amount", `${grossAmount} XAF`],
        [feeLabel, `−${totalFee} XAF`, "color:#dc2626;"],
        [
          "Amount Sent",
          `${sellerReceives} XAF`,
          "font-weight:700;color:#16a34a;font-size:15px;",
        ],
        ["Sent To", invoiceUser.phone],
        ["Status", "&#10003;&nbsp;Paid Out", "color:#16a34a;font-weight:600;"],
      ])}
      <p style="color:#475569;margin-top:12px;">Your official payout receipt is attached to this email as a PDF. You can also download it at any time using the button below.</p>
      ${emailButton(sellerReceiptDownloadLink, "Download PDF Receipt")}`,
      {
        footerNote:
          "Thank you for using Fonlok. This email confirms your payout has been processed. Please keep this receipt for your records.",
      },
    ),
    ...(sellerPdfAttachment ? { attachments: [sellerPdfAttachment] } : {}),
  };

  try {
    await sgMail.send(sellerReceiptMsg);
    console.log("✅ Seller receipt email sent.");
  } catch (error) {
    console.error(
      "❌ Seller Receipt Email Error:",
      error.response ? error.response.body : error.message,
    );
  }

  return true;
};

// --- METHOD 1: RELEASE BY CODE (Manual Request by seller) ---
// The frontend sends: { code: "XXXXXXXX", invoiceNumber: "INV-XXXX" }
// The seller enters the 8-character code given to them by the buyer.
router.post("/release-funds", async (req, res) => {
  const { code, invoiceNumber } = req.body;

  if (!code || !invoiceNumber) {
    return res
      .status(400)
      .json({ error: "Both code and invoice number are required." });
  }

  try {
    // Step 1: Resolve the human-readable invoice number to a DB record
    const invoiceRes = await db.query(
      "SELECT * FROM invoices WHERE invoicenumber = $1",
      [invoiceNumber],
    );
    if (invoiceRes.rows.length === 0) {
      return res
        .status(404)
        .json({ error: `Invoice ${invoiceNumber} does not exist.` });
    }
    const invoice = invoiceRes.rows[0];
    const invoiceId = invoice.id; // numeric DB primary key
    const sellerId = invoice.userid; // seller's user id

    // Guard: invoice already fully paid out &mdash; gives a clean UI error before
    // touching confirmation_codes or calling executePayout.
    if (invoice.status === "completed") {
      return res
        .status(400)
        .json({ error: `Invoice ${invoiceNumber} has already been paid out.` });
    }

    // Step 2: Confirm the invoice has been paid
    const paymentCheck = await db.query(
      "SELECT * FROM payments WHERE invoiceid = $1",
      [invoiceId],
    );
    const payment = paymentCheck.rows[0];
    if (!payment || payment.status !== "paid") {
      return res
        .status(400)
        .json({ error: `Invoice ${invoiceNumber} has not been paid yet.` });
    }

    // Step 3 & 4: Fetch the confirmation code once &mdash; use it for both the
    // duplicate-payout check (is_used) and the code-match validation.
    const codeCheck = await db.query(
      "SELECT * FROM confirmation_codes WHERE code_id = $1",
      [invoiceId],
    );
    if (codeCheck.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "No confirmation code found for this invoice." });
    }
    const codeRow = codeCheck.rows[0];

    // is_used is the authoritative per-invoice "already paid out" flag
    if (codeRow.is_used) {
      return res
        .status(400)
        .json({ error: `Invoice ${invoiceNumber} has already been paid out.` });
    }

    if (codeRow.code !== code) {
      return res.status(401).json({
        error:
          "The code you entered is incorrect. Please ask the buyer for their code.",
      });
    }

    // Step 5: Execute the payout
    await executePayout(invoiceId);

    return res.status(200).json({
      success: true,
      message:
        "Payout processed successfully. Funds are on their way to your Mobile Money account.",
    });
  } catch (error) {
    console.error("Release-by-code payout failed:", error.message);
    if (!res.headersSent) {
      return res.status(500).json({
        error:
          "An error occurred while processing your payout. Please try again or contact support.",
      });
    }
  }
});

// --- METHOD 2: RELEASE BY EMAIL LINK (Automated) ---

// STEP 1: Buyer clicks the email link and lands on this confirmation page
router.get("/verify-payout/:token/:id", async (req, res) => {
  const { token, id } = req.params;

  try {
    // Check if the token exists
    const user = await db.query(
      "SELECT * FROM confirmation_codes WHERE verification_token = $1",
      [token],
    );
    if (user.rows.length === 0) {
      return res
        .status(404)
        .send(renderPage({
          type: "error",
          title: "Invalid Link",
          body: "This confirmation link does not exist or has already been used.",
          note: "If you believe this is an error, please contact <a href='mailto:support@fonlok.com' style='color:#0F1F3D;'>support@fonlok.com</a>.",
        }));
    }

    const users = user.rows[0];
    const is_used = users.is_used;

    if (is_used) {
      return res
        .status(400)
        .send(renderPage({
          type: "warning",
          title: "Link Already Used",
          body: "These funds have already been released. Each confirmation link can only be used once.",
          note: "If you have any questions, contact <a href='mailto:support@fonlok.com' style='color:#0F1F3D;'>support@fonlok.com</a>.",
        }));
    }

    // Token is valid — show the confirmation page instead of executing immediately
    res.send(renderPage({
      type: "warning",
      title: "Release Funds to Seller?",
      body: "You are about to release the escrowed funds to the seller for this invoice.",
      warningBox: "<strong>This action cannot be undone.</strong><br>Only confirm if you have received your order and are fully satisfied. If there is an issue, contact the seller before proceeding.",
      formAction: `/api/verify-payout/${token}/${id}`,
      formLabel: "✓ Yes, Release Funds to Seller",
      note: "If you have not received your order or are not satisfied, do <strong>not</strong> click the button above.",
    }));
  } catch (error) {
    console.error("Confirmation Page Error:", error.message);
    res.status(500).send(renderPage({
      type: "error",
      title: "Something Went Wrong",
      body: "An unexpected error occurred. Please try again or contact support.",
      note: "Email us at <a href='mailto:support@fonlok.com' style='color:#0F1F3D;'>support@fonlok.com</a> with your invoice number.",
    }));
  }
});

// STEP 2: Buyer clicks "Yes, Release Funds" on the confirmation page - now we execute the payout
router.post("/verify-payout/:token/:id", async (req, res) => {
  const { token, id } = req.params;

  try {
    // Get user from the token
    const user = await db.query(
      "SELECT * FROM confirmation_codes WHERE verification_token = $1",
      [token],
    );
    if (user.rows.length === 0) {
      return res
        .status(404)
        .send(renderPage({
          type: "error",
          title: "Invalid Link",
          body: "This confirmation link does not exist or has already been used.",
          note: "If you believe this is an error, contact <a href='mailto:support@fonlok.com' style='color:#0F1F3D;'>support@fonlok.com</a>.",
        }));
    }

    const users = user.rows[0];
    const userId = users.userid;
    const is_used = users.is_used;
    const userInvoiceId = users.code_id;

    if (is_used) {
      return res
        .status(400)
        .send(renderPage({
          type: "warning",
          title: "Link Already Used",
          body: "These funds have already been released. Each confirmation link can only be used once.",
          note: "If you have any questions, contact <a href='mailto:support@fonlok.com' style='color:#0F1F3D;'>support@fonlok.com</a>.",
        }));
    }

    // ── Security: verify the URL :id param matches the token's invoice ────
    if (String(userInvoiceId) !== String(id)) {
      return res
        .status(400)
        .send(renderPage({
          type: "error",
          title: "Invalid Request",
          body: "The link parameters do not match. This link may have been tampered with.",
          note: "If you received this link by email from Fonlok and believe this is an error, contact <a href='mailto:support@fonlok.com' style='color:#0F1F3D;'>support@fonlok.com</a>.",
        }));
    }

    // Re-verify that the payment is actually paid before releasing
    const paymentCheck = await db.query(
      "SELECT status FROM payments WHERE invoiceid = $1",
      [userInvoiceId],
    );
    if (!paymentCheck.rows[0] || paymentCheck.rows[0].status !== "paid") {
      return res
        .status(400)
        .send(renderPage({
          type: "warning",
          title: "Payment Not Yet Confirmed",
          body: "The buyer\u2019s payment has not been confirmed yet. Funds can only be released once the payment clears.",
          note: "Please check back shortly, or contact <a href='mailto:support@fonlok.com' style='color:#0F1F3D;'>support@fonlok.com</a> if this persists.",
        }));
    }

    // Execute the payout — pass the invoice id from the token (authoritative)
    await executePayoutLink(userInvoiceId);

    res.send(renderPage({
      type: "success",
      title: "Funds Released",
      body: "You have successfully released the escrowed funds to the seller. The seller will receive a notification and payment confirmation by email.",
      note: "Thank you for using Fonlok. You can close this page.",
    }));
  } catch (error) {
    console.error("Link Payout Failed:", error.message);
    res.status(500).send(renderPage({
      type: "error",
      title: "Something Went Wrong",
      body: "An unexpected error occurred while processing the fund release. No money has been moved.",
      note: "Please contact <a href='mailto:support@fonlok.com' style='color:#0F1F3D;'>support@fonlok.com</a> with your invoice number.",
    }));
  }
});

// --- METHOD 3a: MILESTONE RELEASE — Direct JSON API (buyer dashboard UI) ---
// POST /release-milestone/confirm
// Body: { invoice_number, buyer_token, milestone_id }
//
// Authenticated via the buyer's chat token (same token used in /chat/:invoice).
// Returns JSON so the buyer can release a milestone directly from the UI
// without needing to use the email link.
// MUST be registered before /release-milestone/:token so Express does not
// treat the literal string "confirm" as a :token parameter.

router.post("/release-milestone/confirm", async (req, res) => {
  const { invoice_number, buyer_token, milestone_id } = req.body;

  if (!invoice_number || !buyer_token || !milestone_id) {
    return res.status(400).json({ message: "Missing required fields." });
  }

  try {
    // 1. Verify the buyer's chat token against the guests table
    const guestResult = await db.query(
      "SELECT * FROM guests WHERE invoicenumber = $1 AND chat_token = $2",
      [invoice_number, buyer_token],
    );
    if (guestResult.rows.length === 0) {
      return res.status(401).json({ message: "Invalid access token." });
    }

    // 2. Get the milestone and confirm it belongs to this invoice
    const msResult = await db.query(
      "SELECT im.* FROM invoice_milestones im JOIN invoices i ON i.id = im.invoice_id WHERE im.id = $1 AND i.invoicenumber = $2",
      [milestone_id, invoice_number],
    );
    if (msResult.rows.length === 0) {
      return res.status(404).json({ message: "Milestone not found." });
    }
    const milestone = msResult.rows[0];

    // 3. Status guards — give precise errors before touching the DB lock
    if (milestone.status === "released") {
      return res
        .status(400)
        .json({ message: "This milestone has already been released." });
    }
    if (milestone.status !== "completed") {
      return res.status(400).json({
        message:
          "This milestone cannot be released yet. The seller must mark it as complete first.",
      });
    }

    // 4. Fetch invoice and seller
    const invoiceResult = await db.query(
      "SELECT * FROM invoices WHERE id = $1",
      [milestone.invoice_id],
    );
    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ message: "Invoice not found." });
    }
    const invoice = invoiceResult.rows[0];

    const sellerResult = await db.query("SELECT * FROM users WHERE id = $1", [
      invoice.userid,
    ]);
    if (sellerResult.rows.length === 0) {
      return res.status(404).json({ message: "Seller account not found." });
    }
    const seller = sellerResult.rows[0];

    // 5. Atomic lock — prevents double-release from concurrent requests
    const milestoneLock = await db.query(
      `UPDATE invoice_milestones
          SET status        = 'released',
              released_at   = NOW(),
              release_token = NULL
        WHERE id     = $1
          AND status = 'completed'
        RETURNING id`,
      [milestone.id],
    );
    if (milestoneLock.rows.length === 0) {
      return res
        .status(400)
        .json({ message: "This milestone has already been released." });
    }

    // 6. Fee calculation (identical to email-link route)
    const milestoneAmount = Number(milestone.amount);
    const referrerCheckMs = await db.query(
      "SELECT referred_by FROM users WHERE id = $1",
      [invoice.userid],
    );
    const referrerIdMs = referrerCheckMs.rows[0]?.referred_by ?? null;
    const hasReferralMs = referrerIdMs !== null;

    const msTotalFee = Math.floor(milestoneAmount * TOTAL_FEE_RATE);
    const msReferralEarning = hasReferralMs
      ? Math.floor(milestoneAmount * REFERRAL_FEE_RATE)
      : 0;
    const msFonlokNet = msTotalFee - msReferralEarning;
    const sellerReceives = milestoneAmount - msTotalFee;
    const fonlokFee = msTotalFee;

    // 7. Campay transfer
    const auth = await axios.post(`${process.env.CAMPAY_BASE_URL}token/`, {
      username: process.env.CAMPAY_USERNAME,
      password: process.env.CAMPAY_PASSWORD,
    });
    await axios.post(
      `${process.env.CAMPAY_BASE_URL}withdraw/`,
      {
        amount: sellerReceives.toString(),
        currency: "XAF",
        to: seller.phone,
        description: `Fonlok milestone payout: ${milestone.label} (Invoice ${invoice.invoicenumber})`,
        external_reference: `milestone-${milestone.id}`,
      },
      { headers: { Authorization: `Token ${auth.data.token}` } },
    );

    // 8. Record payout
    await db.query(
      "INSERT INTO payouts (userid, amount, method, status, invoice_id, invoice_number) VALUES ($1, $2, $3, $4, $5, $6)",
      [
        invoice.userid,
        sellerReceives,
        "Mobile Money",
        "paid",
        invoice.id,
        invoice.invoicenumber,
      ],
    );

    // 9. In-app notification to seller
    notifyUser(
      invoice.userid,
      "milestone_released",
      "Milestone Payout Sent",
      `${sellerReceives} XAF has been sent to your Mobile Money account for milestone: \"${milestone.label}\".`,
      {
        milestoneLabel: milestone.label,
        amount: sellerReceives,
        invoiceNumber: invoice.invoicenumber,
      },
    );

    // 10. Referral credit (non-fatal)
    if (hasReferralMs && msReferralEarning > 0) {
      try {
        const msEarningsInsert = await db.query(
          `INSERT INTO referral_earnings
             (referrer_userid, referred_userid, invoice_number, invoice_amount, earned_amount)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (invoice_number) DO NOTHING
           RETURNING id`,
          [
            referrerIdMs,
            invoice.userid,
            `${invoice.invoicenumber}-ms${milestone.id}`,
            milestoneAmount,
            msReferralEarning,
          ],
        );
        if (msEarningsInsert.rows.length > 0) {
          await db.query(
            "UPDATE users SET referral_balance = referral_balance + $1 WHERE id = $2",
            [msReferralEarning, referrerIdMs],
          );
          console.log(
            `✅ Milestone referral: ${msReferralEarning} XAF credited to user ${referrerIdMs}.`,
          );
        }
      } catch (referralErr) {
        console.error(
          "⚠️ Referral credit error (milestone payout succeeded):",
          referralErr.message,
        );
      }
    }

    // 11. Check if ALL milestones for this invoice are now released
    const remainingResult = await db.query(
      "SELECT COUNT(*) AS remaining FROM invoice_milestones WHERE invoice_id = $1 AND status != 'released'",
      [milestone.invoice_id],
    );
    const remaining = parseInt(remainingResult.rows[0].remaining);
    if (remaining === 0) {
      await db.query("UPDATE invoices SET status = 'completed' WHERE id = $1", [
        milestone.invoice_id,
      ]);
      console.log(
        `✅ All milestones released — invoice ${invoice.invoicenumber} marked completed.`,
      );
    }

    // 12. Email seller receipt (non-fatal)
    try {
      let milestonePdfAttachment = null;
      try {
        const pdfBuffer = await generateReceiptPdf(invoice.invoicenumber);
        milestonePdfAttachment = {
          content: pdfBuffer.toString("base64"),
          filename: `fonlok-receipt-${invoice.invoicenumber}.pdf`,
          type: "application/pdf",
          disposition: "attachment",
        };
      } catch (pdfErr) {
        console.error(
          "⚠️ Could not generate milestone receipt PDF:",
          pdfErr.message,
        );
      }
      const msFeeLabel = hasReferralMs
        ? "Fonlok Fee (1.5%)"
        : "Fonlok Fee (2%)";
      const milestoneReceiptLink = `${process.env.BACKEND_URL}/invoice/receipt/${invoice.invoicenumber}`;
      const sellerMsg = {
        to: seller.email,
        from: process.env.VERIFIED_SENDER,
        subject: `Milestone Payment Released — ${milestone.label} | Fonlok`,
        html: emailWrap(
          `<h2 style="color:#0F1F3D;margin:0 0 12px;">Milestone Payment Sent &mdash; ${milestone.label}</h2>
          <p style="color:#475569;">Hello ${seller.name}, the buyer has confirmed <strong>${milestone.label}</strong> for invoice <strong>${invoice.invoicename}</strong> and your payment has been processed.</p>
          ${emailTable([
            ["Invoice", invoice.invoicenumber],
            ["Milestone", milestone.label],
            ["Gross Amount", `${milestoneAmount} XAF`],
            [msFeeLabel, `−${fonlokFee} XAF`, "color:#dc2626;"],
            [
              "Amount Sent to You",
              `${sellerReceives} XAF`,
              "font-weight:700;color:#16a34a;font-size:15px;",
            ],
            ["Sent To", seller.phone],
          ])}
          ${
            remaining === 0
              ? '<p style="color:#16a34a;font-weight:600;margin-top:12px;">All milestones have been released. This invoice is now complete.</p>'
              : `<p style="color:#475569;margin-top:12px;">Remaining milestones: <strong>${remaining}</strong></p>`
          }
          ${emailButton(milestoneReceiptLink, "Download PDF Receipt")}`,
          {
            footerNote:
              "Thank you for using Fonlok. This email confirms your milestone payout has been processed.",
          },
        ),
        ...(milestonePdfAttachment
          ? { attachments: [milestonePdfAttachment] }
          : {}),
      };
      await sgMail.send(sellerMsg);
      console.log(`✅ Milestone receipt sent to seller ${seller.email}`);
    } catch (emailErr) {
      console.error(
        "❌ Seller milestone receipt email error:",
        emailErr.message,
      );
    }

    return res.status(200).json({
      message: `Payment released successfully. ${sellerReceives.toLocaleString()} XAF sent to the seller.`,
      sellerReceives,
      milestoneLabel: milestone.label,
      allComplete: remaining === 0,
      remaining,
    });
  } catch (error) {
    console.error("Milestone direct release failed:", error.message);
    return res.status(500).json({
      message:
        "An error occurred while releasing the payment. Please try again or contact support.",
    });
  }
});

// --- METHOD 3b: MILESTONE RELEASE — Authenticated Buyer (logged-in account) ---
// POST /release-milestone/by-user
// Body: { milestone_id }
// Auth: Bearer JWT (Fonlok user account)
//
// Allows a registered buyer to release a completed milestone directly from
// the invoice page without needing the one-time email link.
// Ownership is verified via the guests table (user_id recorded at payment time).

router.post("/release-milestone/by-user", authMiddleware, async (req, res) => {
  const { milestone_id } = req.body;
  const buyerUserId = req.user.id;

  if (!milestone_id) {
    return res.status(400).json({ message: "Missing milestone_id." });
  }

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

    // 2. Get the invoice
    const invoiceResult = await db.query(
      "SELECT * FROM invoices WHERE id = $1",
      [milestone.invoice_id],
    );
    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ message: "Invoice not found." });
    }
    const invoice = invoiceResult.rows[0];

    // 3. Prevent the seller from releasing their own funds
    if (invoice.userid === buyerUserId) {
      return res
        .status(403)
        .json({
          message: "Sellers cannot release their own milestone payments.",
        });
    }

    // 4. Verify the requester actually paid for this invoice
    const guestResult = await db.query(
      "SELECT 1 FROM guests WHERE invoicenumber = $1 AND user_id = $2 LIMIT 1",
      [invoice.invoicenumber, buyerUserId],
    );
    if (guestResult.rows.length === 0) {
      return res
        .status(403)
        .json({
          message: "You are not authorised to release funds for this invoice.",
        });
    }

    // 5. Status guards
    if (milestone.status === "released") {
      return res
        .status(400)
        .json({ message: "This milestone has already been released." });
    }
    if (milestone.status !== "completed") {
      return res.status(400).json({
        message:
          "This milestone cannot be released yet. The seller must mark it as complete first.",
      });
    }

    // 6. Get the seller
    const sellerResult = await db.query("SELECT * FROM users WHERE id = $1", [
      invoice.userid,
    ]);
    if (sellerResult.rows.length === 0) {
      return res.status(404).json({ message: "Seller account not found." });
    }
    const seller = sellerResult.rows[0];

    // 7. Atomic lock — prevents double-release from concurrent requests
    const milestoneLock = await db.query(
      `UPDATE invoice_milestones
          SET status        = 'released',
              released_at   = NOW(),
              release_token = NULL
        WHERE id     = $1
          AND status = 'completed'
        RETURNING id`,
      [milestone.id],
    );
    if (milestoneLock.rows.length === 0) {
      return res
        .status(400)
        .json({ message: "This milestone has already been released." });
    }

    // 8. Fee calculation
    const milestoneAmount = Number(milestone.amount);
    const referrerCheck = await db.query(
      "SELECT referred_by FROM users WHERE id = $1",
      [invoice.userid],
    );
    const referrerId = referrerCheck.rows[0]?.referred_by ?? null;
    const hasReferral = referrerId !== null;

    const totalFee = Math.floor(milestoneAmount * TOTAL_FEE_RATE);
    const referralEarning = hasReferral
      ? Math.floor(milestoneAmount * REFERRAL_FEE_RATE)
      : 0;
    const sellerReceives = milestoneAmount - totalFee;
    const fonlokFee = totalFee;

    // 9. Campay transfer
    const auth = await axios.post(`${process.env.CAMPAY_BASE_URL}token/`, {
      username: process.env.CAMPAY_USERNAME,
      password: process.env.CAMPAY_PASSWORD,
    });
    await axios.post(
      `${process.env.CAMPAY_BASE_URL}withdraw/`,
      {
        amount: sellerReceives.toString(),
        currency: "XAF",
        to: seller.phone,
        description: `Fonlok milestone payout: ${milestone.label} (Invoice ${invoice.invoicenumber})`,
        external_reference: `milestone-${milestone.id}`,
      },
      { headers: { Authorization: `Token ${auth.data.token}` } },
    );

    // 10. Record payout
    await db.query(
      "INSERT INTO payouts (userid, amount, method, status, invoice_id, invoice_number) VALUES ($1, $2, $3, $4, $5, $6)",
      [
        invoice.userid,
        sellerReceives,
        "Mobile Money",
        "paid",
        invoice.id,
        invoice.invoicenumber,
      ],
    );

    // 11. In-app notification to seller
    notifyUser(
      invoice.userid,
      "milestone_released",
      "Milestone Payout Sent",
      `${sellerReceives} XAF has been sent to your Mobile Money account for milestone: "${milestone.label}".`,
      {
        milestoneLabel: milestone.label,
        amount: sellerReceives,
        invoiceNumber: invoice.invoicenumber,
      },
    );

    // 12. Referral credit (non-fatal)
    if (hasReferral && referralEarning > 0) {
      try {
        const earningsInsert = await db.query(
          `INSERT INTO referral_earnings
             (referrer_userid, referred_userid, invoice_number, invoice_amount, earned_amount)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (invoice_number) DO NOTHING
           RETURNING id`,
          [
            referrerId,
            invoice.userid,
            `${invoice.invoicenumber}-ms${milestone.id}`,
            milestoneAmount,
            referralEarning,
          ],
        );
        if (earningsInsert.rows.length > 0) {
          await db.query(
            "UPDATE users SET referral_balance = referral_balance + $1 WHERE id = $2",
            [referralEarning, referrerId],
          );
        }
      } catch (referralErr) {
        console.error(
          "\u26a0\ufe0f Referral credit error (milestone payout succeeded):",
          referralErr.message,
        );
      }
    }

    // 13. Check if all milestones for this invoice are now released
    const remainingResult = await db.query(
      "SELECT COUNT(*) AS remaining FROM invoice_milestones WHERE invoice_id = $1 AND status != 'released'",
      [milestone.invoice_id],
    );
    const remaining = parseInt(remainingResult.rows[0].remaining);
    if (remaining === 0) {
      await db.query("UPDATE invoices SET status = 'completed' WHERE id = $1", [
        milestone.invoice_id,
      ]);
    }

    // 14. Email seller receipt (non-fatal)
    try {
      let pdfAttachment = null;
      try {
        const pdfBuffer = await generateReceiptPdf(invoice.invoicenumber);
        pdfAttachment = {
          content: pdfBuffer.toString("base64"),
          filename: `fonlok-receipt-${invoice.invoicenumber}.pdf`,
          type: "application/pdf",
          disposition: "attachment",
        };
      } catch (pdfErr) {
        console.error(
          "\u26a0\ufe0f Could not generate milestone receipt PDF:",
          pdfErr.message,
        );
      }
      const feeLabel = hasReferral ? "Fonlok Fee (1.5%)" : "Fonlok Fee (2%)";
      const receiptLink = `${process.env.BACKEND_URL}/invoice/receipt/${invoice.invoicenumber}`;
      await sgMail.send({
        to: seller.email,
        from: process.env.VERIFIED_SENDER,
        subject: `Milestone Payment Released \u2014 ${milestone.label} | Fonlok`,
        html: emailWrap(
          `<h2 style="color:#0F1F3D;margin:0 0 12px;">Milestone Payment Sent &mdash; ${milestone.label}</h2>
          <p style="color:#475569;">Hello ${seller.name}, the buyer has confirmed <strong>${milestone.label}</strong> for invoice <strong>${invoice.invoicename}</strong> and your payment has been processed.</p>
          ${emailTable([
            ["Invoice", invoice.invoicenumber],
            ["Milestone", milestone.label],
            ["Gross Amount", `${milestoneAmount} XAF`],
            [feeLabel, `\u2212${fonlokFee} XAF`, "color:#dc2626;"],
            [
              "Amount Sent to You",
              `${sellerReceives} XAF`,
              "font-weight:700;color:#16a34a;font-size:15px;",
            ],
            ["Sent To", seller.phone],
          ])}
          ${
            remaining === 0
              ? '<p style="color:#16a34a;font-weight:600;margin-top:12px;">All milestones have been released. This invoice is now complete.</p>'
              : `<p style="color:#475569;margin-top:12px;">Remaining milestones: <strong>${remaining}</strong></p>`
          }
          ${emailButton(receiptLink, "Download PDF Receipt")}`,
          {
            footerNote:
              "Thank you for using Fonlok. This email confirms your milestone payout has been processed.",
          },
        ),
        ...(pdfAttachment ? { attachments: [pdfAttachment] } : {}),
      });
    } catch (emailErr) {
      console.error(
        "\u274c Seller milestone receipt email error:",
        emailErr.response?.body || emailErr.message,
      );
    }

    return res.status(200).json({
      message: `Payment released successfully. ${sellerReceives.toLocaleString()} XAF sent to the seller.`,
      sellerReceives,
      milestoneLabel: milestone.label,
      allComplete: remaining === 0,
      remaining,
    });
  } catch (error) {
    console.error("\u274c Milestone release (by-user) failed:", error.message);
    return res.status(500).json({
      message:
        "An error occurred while releasing the payment. Please try again or contact support.",
    });
  }
});

// --- METHOD 3: MILESTONE RELEASE ---
// GET  \u2192 shows the buyer a confirmation page (no money moves).
// POST \u2192 executes the payout atomically after the buyer confirms.
//
// Previously the GET fired the payout immediately, which meant any email-
// client link-prefetcher, Outlook Safe Links scanner, or Gmail preview fetch
// could silently trigger an irreversible money transfer.  The GET now only
// renders a confirmation card; the actual payout runs exclusively on POST.

router.get("/release-milestone/:token", async (req, res) => {
  const { token } = req.params;

  try {
    const msResult = await db.query(
      "SELECT * FROM invoice_milestones WHERE release_token = $1",
      [token],
    );
    if (msResult.rows.length === 0) {
      return res.status(404).send(renderPage({
        type: "error",
        title: "Invalid Link",
        body: "This milestone release link is invalid or has already been used.",
        note: "If you believe this is an error, contact <a href='mailto:support@fonlok.com' style='color:#0F1F3D;'>support@fonlok.com</a>.",
      }));
    }
    const milestone = msResult.rows[0];
    if (milestone.status === "released") {
      return res.status(400).send(renderPage({
        type: "success",
        title: "Already Released",
        body: "This milestone has already been paid out to the seller.",
        note: "No further action is required. Thank you for using Fonlok.",
      }));
    }
    if (milestone.status !== "completed") {
      return res.status(400).send(renderPage({
        type: "warning",
        title: "Milestone Not Yet Complete",
        body: "This milestone has not been marked as complete by the seller yet. You can only release payment once the seller has confirmed the work is done.",
        note: "Please check back once the seller has completed this milestone, or contact <a href='mailto:support@fonlok.com' style='color:#0F1F3D;'>support@fonlok.com</a>.",
      }));
    }

    // Show confirmation page — payout only fires on POST
    res.send(renderPage({
      type: "warning",
      title: `Release Payment for \u201c${milestone.label}\u201d?`,
      body: `You are about to release the escrowed payment for milestone: <strong>${milestone.label}</strong>.`,
      warningBox: "<strong>This action cannot be undone.</strong><br>Only confirm if the seller has completed this milestone to your full satisfaction. If there is any issue, contact the seller first.",
      formAction: `/api/release-milestone/${token}`,
      formLabel: "\u2713 Yes, Release Payment to Seller",
      note: "If the milestone is not yet complete, do <strong>not</strong> click the button above.",
    }));
  } catch (error) {
    console.error("Milestone confirmation page error:", error.message);
    res.status(500).send(renderPage({
      type: "error",
      title: "Something Went Wrong",
      body: "An unexpected error occurred. Please try again or contact support.",
      note: "Email us at <a href='mailto:support@fonlok.com' style='color:#0F1F3D;'>support@fonlok.com</a> with your invoice number.",
    }));
  }
});

router.post("/release-milestone/:token", async (req, res) => {
  const { token } = req.params;

  try {
    // 1. Find the milestone by its release token
    const msResult = await db.query(
      "SELECT * FROM invoice_milestones WHERE release_token = $1",
      [token],
    );
    if (msResult.rows.length === 0) {
      return res.status(404).send(renderPage({
        type: "error",
        title: "Invalid Link",
        body: "This milestone release link is invalid or has already been used.",
        note: "If you believe this is an error, contact <a href='mailto:support@fonlok.com' style='color:#0F1F3D;'>support@fonlok.com</a>.",
      }));
    }

    const milestone = msResult.rows[0];

    // 2. Guard checks — give precise error messages before the atomic lock
    if (milestone.status === "released") {
      return res.status(400).send(renderPage({
        type: "success",
        title: "Already Released",
        body: "This milestone has already been paid out to the seller.",
        note: "No further action is required. Thank you for using Fonlok.",
      }));
    }
    if (milestone.status !== "completed") {
      return res.status(400).send(renderPage({
        type: "warning",
        title: "Milestone Not Yet Complete",
        body: "This milestone has not been marked as complete by the seller yet. You can only release payment once the seller has confirmed the work is done.",
        note: "Please check back once the seller has completed this milestone, or contact <a href='mailto:support@fonlok.com' style='color:#0F1F3D;'>support@fonlok.com</a>.",
      }));
    }

    // 3. Get the invoice
    const invoiceResult = await db.query(
      "SELECT * FROM invoices WHERE id = $1",
      [milestone.invoice_id],
    );
    if (invoiceResult.rows.length === 0) {
      return res.status(404).send(renderPage({
        type: "error",
        title: "Invoice Not Found",
        body: "We could not find the invoice associated with this milestone.",
        note: "Contact <a href='mailto:support@fonlok.com' style='color:#0F1F3D;'>support@fonlok.com</a> with your invoice number for assistance.",
      }));
    }
    const invoice = invoiceResult.rows[0];

    // 4. Get the seller info
    const sellerResult = await db.query("SELECT * FROM users WHERE id = $1", [
      invoice.userid,
    ]);
    if (sellerResult.rows.length === 0) {
      return res.status(404).send(renderPage({
        type: "error",
        title: "Seller Not Found",
        body: "We could not find the seller account for this invoice.",
        note: "Contact <a href='mailto:support@fonlok.com' style='color:#0F1F3D;'>support@fonlok.com</a> with your invoice number for assistance.",
      }));
    }
    const seller = sellerResult.rows[0];

    // ── Step 5: Atomically claim this milestone (race-condition lock) ───────
    // UPDATE only succeeds when status is currently 'completed'.  A concurrent
    // request will find status = 'released' and get zero rows → aborts before
    // any money moves.
    const milestoneLock = await db.query(
      `UPDATE invoice_milestones
          SET status        = 'released',
              released_at   = NOW(),
              release_token = NULL
        WHERE id     = $1
          AND status = 'completed'
        RETURNING id`,
      [milestone.id],
    );
    if (milestoneLock.rows.length === 0) {
      return res.status(400).send(renderPage({
        type: "success",
        title: "Already Released",
        body: "This milestone has already been paid out to the seller.",
        note: "No further action is required. Thank you for using Fonlok.",
      }));
    }

    // ── Step 6: Calculate fees ───────────────────────────────────────────────
    const milestoneAmount = Number(milestone.amount);

    // Same split as invoice payouts:
    //   referral involved  → seller gets gross−2%, referrer gets 0.5%, Fonlok 1.5%
    //   no referral        → seller gets gross−2%, Fonlok 2%
    const referrerCheckMs = await db.query(
      "SELECT referred_by FROM users WHERE id = $1",
      [invoice.userid],
    );
    const referrerIdMs = referrerCheckMs.rows[0]?.referred_by ?? null;
    const hasReferralMs = referrerIdMs !== null;

    const msTotalFee = Math.floor(milestoneAmount * TOTAL_FEE_RATE); // 2%
    const msReferralEarning = hasReferralMs
      ? Math.floor(milestoneAmount * REFERRAL_FEE_RATE) // 0.5%
      : 0;
    const msFonlokNet = msTotalFee - msReferralEarning; // 1.5% or 2%
    const sellerReceives = milestoneAmount - msTotalFee; // gross − 2%
    const fonlokFee = msTotalFee; // kept for email label

    console.log(
      `Milestone ${milestone.id} (${milestone.label}): gross=${milestoneAmount}, ` +
        `totalFee=${msTotalFee}, fonlokNet=${msFonlokNet}, ` +
        `referralEarning=${msReferralEarning}, sellerReceives=${sellerReceives}`,
    );

    // ── Step 7: Transfer to seller via Campay ───────────────────────────────
    const auth = await axios.post(`${process.env.CAMPAY_BASE_URL}token/`, {
      username: process.env.CAMPAY_USERNAME,
      password: process.env.CAMPAY_PASSWORD,
    });

    await axios.post(
      `${process.env.CAMPAY_BASE_URL}withdraw/`,
      {
        amount: sellerReceives.toString(),
        currency: "XAF",
        to: seller.phone,
        description: `Fonlok milestone payout: ${milestone.label} (Invoice ${invoice.invoicenumber})`,
        external_reference: `milestone-${milestone.id}`,
      },
      { headers: { Authorization: `Token ${auth.data.token}` } },
    );

    // ── Step 8: Record payout ────────────────────────────────────────────────
    await db.query(
      "INSERT INTO payouts (userid, amount, method, status, invoice_id, invoice_number) VALUES ($1, $2, $3, $4, $5, $6)",
      [
        invoice.userid,
        sellerReceives,
        "Mobile Money",
        "paid",
        invoice.id,
        invoice.invoicenumber,
      ],
    );

    notifyUser(
      invoice.userid,
      "milestone_released",
      "Milestone Payout Sent",
      `${sellerReceives} XAF has been sent to your Mobile Money account for milestone: "${milestone.label}".`,
      {
        milestoneLabel: milestone.label,
        amount: sellerReceives,
        invoiceNumber: invoice.invoicenumber,
      },
    );

    // ── Step 9: Credit referral earnings &mdash; INSERT first, balance only if new ─
    // INSERT with RETURNING is the source of truth.  Balance UPDATE only runs
    // when a genuinely new row was inserted &mdash; retries never double-credit.
    if (hasReferralMs && msReferralEarning > 0) {
      try {
        const msEarningsInsert = await db.query(
          `INSERT INTO referral_earnings
             (referrer_userid, referred_userid, invoice_number, invoice_amount, earned_amount)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (invoice_number) DO NOTHING
           RETURNING id`,
          [
            referrerIdMs,
            invoice.userid,
            `${invoice.invoicenumber}-ms${milestone.id}`,
            milestoneAmount,
            msReferralEarning,
          ],
        );
        if (msEarningsInsert.rows.length > 0) {
          await db.query(
            "UPDATE users SET referral_balance = referral_balance + $1 WHERE id = $2",
            [msReferralEarning, referrerIdMs],
          );
          console.log(
            `✅ Milestone referral earning of ${msReferralEarning} XAF (0.5%) credited to user ${referrerIdMs}. ` +
              `Fonlok net fee: ${msFonlokNet} XAF (1.5%).`,
          );
        } else {
          console.log(
            `ℹ️ Milestone referral earnings for ${invoice.invoicenumber}-ms${milestone.id} already recorded &mdash; balance not double-credited.`,
          );
        }
      } catch (referralErr) {
        console.error(
          "⚠️ Referral credit error (milestone payout still succeeded):",
          referralErr.message,
        );
      }
    }

    // ── Step 10: Check if ALL milestones for this invoice are now released ────
    const remainingResult = await db.query(
      "SELECT COUNT(*) AS remaining FROM invoice_milestones WHERE invoice_id = $1 AND status != 'released'",
      [milestone.invoice_id],
    );
    const remaining = parseInt(remainingResult.rows[0].remaining);

    if (remaining === 0) {
      await db.query("UPDATE invoices SET status = 'completed' WHERE id = $1", [
        milestone.invoice_id,
      ]);
      console.log(
        `✅ All milestones released &mdash; invoice ${invoice.invoicenumber} marked as completed.`,
      );
    }

    // ── Step 11: Email the seller their receipt ───────────────────────────────
    try {
      let milestonePdfAttachment = null;
      try {
        const pdfBuffer = await generateReceiptPdf(invoice.invoicenumber);
        milestonePdfAttachment = {
          content: pdfBuffer.toString("base64"),
          filename: `fonlok-receipt-${invoice.invoicenumber}.pdf`,
          type: "application/pdf",
          disposition: "attachment",
        };
      } catch (pdfErr) {
        console.error(
          "⚠️ Could not generate milestone receipt PDF:",
          pdfErr.message,
        );
      }

      const msFeeLabel = hasReferralMs
        ? "Fonlok Fee (1.5%)"
        : "Fonlok Fee (2%)";
      const milestoneReceiptLink = `${process.env.BACKEND_URL}/invoice/receipt/${invoice.invoicenumber}`;
      const sellerMsg = {
        to: seller.email,
        from: process.env.VERIFIED_SENDER,
        subject: `Milestone Payment Released  - ${milestone.label} | Fonlok`,
        html: emailWrap(
          `<h2 style="color:#0F1F3D;margin:0 0 12px;">Milestone Payment Sent &mdash; ${milestone.label}</h2>
          <p style="color:#475569;">Hello ${seller.name}, the buyer has confirmed <strong>${milestone.label}</strong> for invoice <strong>${invoice.invoicename}</strong> and your payment has been processed.</p>
          ${emailTable([
            ["Invoice", invoice.invoicenumber],
            ["Milestone", milestone.label],
            ["Gross Amount", `${milestoneAmount} XAF`],
            [msFeeLabel, `−${fonlokFee} XAF`, "color:#dc2626;"],
            [
              "Amount Sent to You",
              `${sellerReceives} XAF`,
              "font-weight:700;color:#16a34a;font-size:15px;",
            ],
            ["Sent To", seller.phone],
          ])}
          ${
            remaining === 0
              ? '<p style="color:#16a34a;font-weight:600;margin-top:12px;">All milestones have been released. This invoice is now complete.</p>'
              : `<p style="color:#475569;margin-top:12px;">Remaining milestones: <strong>${remaining}</strong></p>`
          }
          <p style="color:#475569;margin-top:12px;">Your payout receipt is attached to this email as a PDF.</p>
          ${emailButton(milestoneReceiptLink, "Download PDF Receipt")}`,
          {
            footerNote:
              "Thank you for using Fonlok. This email confirms your milestone payout has been processed. Please keep this receipt for your records.",
          },
        ),
        ...(milestonePdfAttachment
          ? { attachments: [milestonePdfAttachment] }
          : {}),
      };
      await sgMail.send(sellerMsg);
      console.log(`✅ Milestone receipt sent to seller ${seller.email}`);
    } catch (emailErr) {
      console.error(
        "❌ Seller milestone receipt email error:",
        emailErr.message,
      );
    }

    // 13. Return a clean success page to the buyer
    return res.send(renderPage({
      type: "success",
      title: "Funds Released",
      body: `You have successfully released <strong>${sellerReceives} XAF</strong> to the seller for milestone: <strong>${milestone.label}</strong>.` +
        (remaining === 0
          ? `<br><br><span style="color:#16a34a;font-weight:600;">All milestones are now complete. This invoice is fully settled.</span>`
          : `<br><br>The seller will be notified to proceed with the next milestone.`),
      note: "Thank you for using Fonlok. You can close this page.",
    }));
  } catch (error) {
    console.error("Milestone release failed:", error.message);
    return res.status(500).send(renderPage({
      type: "error",
      title: "Something Went Wrong",
      body: "An unexpected error occurred while processing the fund release. No money has been moved.",
      note: "Please contact <a href='mailto:support@fonlok.com' style='color:#0F1F3D;'>support@fonlok.com</a> with your invoice number.",
    }));
  }
});

export default router;
