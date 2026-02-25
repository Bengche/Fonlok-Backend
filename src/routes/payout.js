import express from "express";
const router = express.Router();
import axios from "axios";
import dotenv from "dotenv";
import db from "../controllers/db.js";
import sgMail from "@sendgrid/mail";
import { notifyUser } from "../middleware/notificationHelper.js";
import { emailWrap, emailTable, emailButton } from "../utils/emailTemplate.js";
import { generateReceiptPdf } from "../utils/generateReceipt.js";
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
        .send("<h1>Invalid Link: This token does not exist.</h1>");
    }

    const users = user.rows[0];
    const is_used = users.is_used;

    if (is_used) {
      return res
        .status(400)
        .send("<h1>Link Expired: Payout already processed.</h1>");
    }

    // Token is valid - show the confirmation page instead of executing immediately
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Confirm Fund Release</title>
          <style>
            body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f9fafb; }
            .card { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 40px; max-width: 480px; width: 100%; text-align: center; }
            .warning { background: #fff7ed; border: 1px solid #fed7aa; color: #9a3412; padding: 16px; border-radius: 6px; margin: 20px 0; }
            .btn-confirm { background: #15803d; color: white; border: none; padding: 14px 30px; border-radius: 6px; font-size: 16px; font-weight: bold; cursor: pointer; width: 100%; margin-top: 10px; }
            .btn-confirm:hover { background: #166534; }
            .btn-cancel { display: inline-block; margin-top: 12px; color: #6b7280; text-decoration: underline; cursor: pointer; background: none; border: none; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>⚠️ Release Funds to Seller?</h2>
            <p>You are about to release the escrowed funds to the seller.</p>

            <div class="warning">
              <strong>This action cannot be undone.</strong><br/>
              Only confirm if you have received your order and are fully satisfied with it.
            </div>

            <p>Are you sure you want to release the funds?</p>

            <!-- This form POSTs to the same URL to trigger the actual payout -->
            <form method="POST" action="/api/verify-payout/${token}/${id}">
              <button type="submit" class="btn-confirm">✅ Yes, Release Funds to Seller</button>
            </form>

            <br/>
            <p style="color: #6b7280; font-size: 13px;">If you have not received your order or are not satisfied, do NOT click the button above. Contact the seller to resolve the issue first.</p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Confirmation Page Error:", error.message);
    res.status(500).send("<h1>System Error: Please contact support.</h1>");
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
        .send("<h1>Invalid Link: This token does not exist.</h1>");
    }

    const users = user.rows[0];
    const userId = users.userid;
    const is_used = users.is_used;
    const userInvoiceId = users.code_id;

    if (is_used) {
      return res
        .status(400)
        .send("<h1>Link Expired: Payout already processed.</h1>");
    }

    // ── Security: verify the URL :id param matches the token's invoice ────
    // This prevents someone from using a valid token for invoice A to trigger
    // a payout for a completely different invoice B by manipulating the URL.
    if (String(userInvoiceId) !== String(id)) {
      return res
        .status(400)
        .send("<h1>Invalid Request: Link parameters do not match.</h1>");
    }

    // Re-verify that the payment is actually paid before releasing
    const paymentCheck = await db.query(
      "SELECT status FROM payments WHERE invoiceid = $1",
      [userInvoiceId],
    );
    if (!paymentCheck.rows[0] || paymentCheck.rows[0].status !== "paid") {
      return res
        .status(400)
        .send("<h1>Wait: The buyer hasn't completed the payment yet.</h1>");
    }

    // Execute the payout &mdash; pass the invoice id from the token (authoritative),
    // not the raw :id URL param which has already been validated to match above.
    await executePayoutLink(userInvoiceId);

    res.send("<h1>✅ Success! Funds have been released to the seller.</h1>");
  } catch (error) {
    console.error("Link Payout Failed:", error.message);
    res.status(500).send("<h1>System Error: Please contact support.</h1>");
  }
});

// --- METHOD 3: MILESTONE RELEASE ---
// GET  → shows the buyer a confirmation page (no money moves).
// POST → executes the payout atomically after the buyer confirms.
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
      return res.status(404).send(`
        <html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center;">
          <h2 style="color:#dc2626;">Invalid Link</h2>
          <p>This release link is invalid or has already been used.</p>
        </body></html>
      `);
    }
    const milestone = msResult.rows[0];
    if (milestone.status === "released") {
      return res.status(400).send(`
        <html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center;">
          <h2 style="color:#f59e0b;">Already Released</h2>
          <p>This milestone has already been paid out to the seller.</p>
        </body></html>
      `);
    }
    if (milestone.status !== "completed") {
      return res.status(400).send(`
        <html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center;">
          <h2 style="color:#dc2626;">Not Ready</h2>
          <p>This milestone has not been marked as complete by the seller yet.</p>
        </body></html>
      `);
    }

    // Show confirmation page &mdash; payout only fires on POST
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Confirm Milestone Release &mdash; Fonlok</title>
          <style>
            body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f9fafb; }
            .card { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 40px; max-width: 480px; width: 100%; text-align: center; }
            .warning { background: #fff7ed; border: 1px solid #fed7aa; color: #9a3412; padding: 16px; border-radius: 6px; margin: 20px 0; }
            .btn-confirm { background: #15803d; color: white; border: none; padding: 14px 30px; border-radius: 6px; font-size: 16px; font-weight: bold; cursor: pointer; width: 100%; margin-top: 10px; }
            .btn-confirm:hover { background: #166534; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>⚠️ Release Milestone Payment?</h2>
            <p>You are about to release payment for milestone:</p>
            <p><strong>${milestone.label}</strong></p>
            <div class="warning">
              <strong>This action cannot be undone.</strong><br/>
              Only confirm if the seller has completed this milestone to your full satisfaction.
            </div>
            <p>Are you sure you want to release the funds?</p>
            <form method="POST" action="/api/release-milestone/${token}">
              <button type="submit" class="btn-confirm">✅ Yes, Release Payment to Seller</button>
            </form>
            <br/>
            <p style="color:#6b7280;font-size:13px;">If the milestone is not yet complete, do NOT click the button above. Contact the seller to resolve the issue first.</p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Milestone confirmation page error:", error.message);
    res.status(500).send("<h1>System Error: Please contact support.</h1>");
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
      return res.status(404).send(`
        <html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center;">
          <h2 style="color:#dc2626;">Invalid Link</h2>
          <p>This release link is invalid or has already been used.</p>
        </body></html>
      `);
    }

    const milestone = msResult.rows[0];

    // 2. Guard checks &mdash; give precise error messages before the atomic lock
    if (milestone.status === "released") {
      return res.status(400).send(`
        <html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center;">
          <h2 style="color:#f59e0b;">Already Released</h2>
          <p>This milestone has already been paid out to the seller.</p>
        </body></html>
      `);
    }
    if (milestone.status !== "completed") {
      return res.status(400).send(`
        <html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center;">
          <h2 style="color:#dc2626;">Not Ready</h2>
          <p>This milestone has not been marked as complete by the seller yet.</p>
        </body></html>
      `);
    }

    // 3. Get the invoice
    const invoiceResult = await db.query(
      "SELECT * FROM invoices WHERE id = $1",
      [milestone.invoice_id],
    );
    if (invoiceResult.rows.length === 0) {
      return res.status(404).send("<h2>Invoice not found.</h2>");
    }
    const invoice = invoiceResult.rows[0];

    // 4. Get the seller info
    const sellerResult = await db.query("SELECT * FROM users WHERE id = $1", [
      invoice.userid,
    ]);
    if (sellerResult.rows.length === 0) {
      return res.status(404).send("<h2>Seller not found.</h2>");
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
      return res.status(400).send(`
        <html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center;">
          <h2 style="color:#f59e0b;">Already Released</h2>
          <p>This milestone has already been paid out to the seller.</p>
        </body></html>
      `);
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
    return res.send(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <title>Funds Released &mdash; Fonlok</title>
        </head>
        <body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center;padding:0 20px;">
          <div style="background:#0F1F3D;width:56px;height:56px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:24px;">
            <span style="color:#F59E0B;font-size:26px;font-weight:900;">F</span>
          </div>
          <h1 style="color:#0F1F3D;font-size:24px;margin-bottom:8px;">Funds Released</h1>
          <p style="color:#334155;line-height:1.6;">
            You have successfully released <strong>${sellerReceives} XAF</strong> to the seller for:
            <br><strong>${milestone.label}</strong>
          </p>
          ${
            remaining === 0
              ? `<p style="color:#16a34a;font-weight:600;">All milestones are now complete. This invoice is fully settled.</p>`
              : `<p style="color:#64748b;font-size:14px;">The seller will be notified to proceed with the next milestone.</p>`
          }
          <p style="color:#94a3b8;font-size:13px;margin-top:32px;">Thank you for using Fonlok.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Milestone release failed:", error.message);
    return res.status(500).send(`
      <html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center;">
        <h2 style="color:#dc2626;">Something went wrong</h2>
        <p>Please contact support at support@fonlok.com and include your invoice number.</p>
      </body></html>
    `);
  }
});

export default router;
