import express from "express";
import axios from "axios";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import db from "../controllers/db.js";
import crypto from "crypto";
import { notifyUser } from "../middleware/notificationHelper.js";
import {
  emailWrap,
  emailTable,
  emailButton,
  emailButtonDanger,
} from "../utils/emailTemplate.js";
import { generateReceiptPdf } from "../utils/generateReceipt.js";
import { getUserEmailLanguageByEmail } from "../utils/userLanguage.js";
import { buildEmailCopy } from "../utils/emailLanguageCopy.js";
dotenv.config();
const router = express.Router();
import sgMail from "@sendgrid/mail";
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Generate 8 characters (excludes confusing 0, O, I, 1)
const generate8CharCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

// â”€â”€â”€ Core payment processing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Called by both the Campay webhook AND the frontend poll endpoint so that
// payments are processed regardless of which path fires first.
//
// Returns: "done"         - fully processed right now
//          "already_done" - idempotency guard hit (was processed earlier)
//          "no_payment"   - no matching payments row found
export async function processSuccessfulPayment(paymentUUID) {
  // ── Atomic idempotency claim (race-condition safe) ──────────────────────────────────────────
  // INSERT … ON CONFLICT DO NOTHING is a single atomic DB operation.
  // If two concurrent webhook retries reach here simultaneously, exactly ONE
  // will get rowCount=1 and proceed; the other gets rowCount=0 and exits
  // immediately - no double-charge, no duplicate emails, no infinite loops.
  // This replaces the old SELECT-then-INSERT two-step which had a TOCTOU gap.
  const claim = await db.query(
    `INSERT INTO processed_payments (payment_uuid)
     VALUES ($1)
     ON CONFLICT (payment_uuid) DO NOTHING`,
    [paymentUUID],
  );
  if (claim.rowCount === 0) {
    console.log(
      `Payment ${paymentUUID} already claimed - duplicate webhook ignored.`,
    );
    return "already_done";
  }

  // 1. Find the payments row
  const paymentResult = await db.query(
    "SELECT * FROM payments WHERE providerpaymentid = $1",
    [paymentUUID],
  );
  if (paymentResult.rows.length === 0) {
    console.warn(
      `processSuccessfulPayment: no payment row for UUID ${paymentUUID}`,
    );
    return "no_payment";
  }
  const payment = paymentResult.rows[0];
  const invoiceId = payment.invoiceid;

  // 2. Belt-and-suspenders: also check confirmation_codes so that payments
  // processed by the old code path (before processed_payments existed) are
  // still recognised as done after a redeployment.
  const alreadyProcessed = await db.query(
    "SELECT 1 FROM confirmation_codes WHERE code_id = $1 LIMIT 1",
    [invoiceId],
  );
  if (alreadyProcessed.rows.length > 0) {
    console.log(
      `Invoice ${invoiceId} already has a confirmation code - skipping.`,
    );
    return "already_done";
  }

  // 3. Mark payment + invoice as paid
  await db.query(
    "UPDATE payments SET status = 'paid' WHERE providerpaymentid = $1",
    [paymentUUID],
  );
  await db.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [
    invoiceId,
  ]);

  // 4. Get invoice details
  const invoiceResult = await db.query("SELECT * FROM invoices WHERE id = $1", [
    invoiceId,
  ]);
  if (invoiceResult.rows.length === 0) {
    console.error(`âŒ  Invoice ${invoiceId} not found after status update.`);
    return "done";
  }
  const invoice = invoiceResult.rows[0];
  const invoice_number = invoice.invoicenumber;
  const idUser = invoice.userid;
  const isInstallment = invoice.payment_type === "installment";

  // 5. Generate unique confirmation code
  let finalCode = "";
  let confirmationLink = "";
  let isSaved = false;
  while (!isSaved) {
    try {
      finalCode = generate8CharCode();
      const verificationToken = crypto.randomBytes(32).toString("hex");
      confirmationLink = `${process.env.BACKEND_URL}/api/verify-payout/${verificationToken}/${invoiceId}`;
      await db.query(
        "INSERT INTO confirmation_codes (code, code_id, verification_token, userid, invoiceid) VALUES ($1, $2, $3, $4, $5)",
        [finalCode, invoiceId, verificationToken, idUser, invoiceId],
      );
      isSaved = true;
      console.log(`âœ…  Confirmation code saved: ${finalCode}`);
    } catch (err) {
      if (err.code === "23505") {
        continue;
      }
      throw err;
    }
  }

  // 6. Get buyer email (non-fatal - missing email skips emails but doesn't abort)
  let buyerEmail = null;
  try {
    const guestResult = await db.query(
      "SELECT * FROM guests WHERE invoicenumber = $1 ORDER BY created_at DESC LIMIT 1",
      [invoice_number],
    );
    if (guestResult.rows.length > 0) {
      buyerEmail = guestResult.rows[0].email;
    } else {
      console.warn(
        `âš ï¸  No guest row for invoice ${invoice_number} - skipping buyer email.`,
      );
    }
  } catch (guestErr) {
    console.error("âš ï¸  Could not query guests:", guestErr.message);
  }

  // 7. Send confirmation email + receipt to buyer
  // Declared at function scope so step 8 (chat invite) can reference it too.
  let buyerLanguage = "en";
  if (buyerEmail) {
    buyerLanguage = await getUserEmailLanguageByEmail(buyerEmail);
    let buyerPdfAttachment = null;
    try {
      const pdfBuffer = await generateReceiptPdf(invoice_number, buyerLanguage);
      buyerPdfAttachment = {
        content: pdfBuffer.toString("base64"),
        filename: `fonlok-receipt-${invoice_number}.pdf`,
        type: "application/pdf",
        disposition: "attachment",
      };
    } catch (pdfErr) {
      console.error("âš ï¸  Could not generate receipt PDF:", pdfErr.message);
    }

    const receiptDownloadLink = `${process.env.BACKEND_URL}/invoice/receipt/${invoice_number}`;

    // Build the confirmation email differently for full-payment vs milestone invoices.
    let buyerEmailSubject;
    let buyerEmailHtml;

    if (!isInstallment) {
      // ── Full-payment invoice: single one-shot release link ────────────────
      const paymentConfirm = buildEmailCopy(buyerLanguage, "paymentConfirmed");
      buyerEmailSubject = paymentConfirm.subject(invoice_number);
      buyerEmailHtml = emailWrap(
        `<h2 style="color:#0F1F3D;margin:0 0 12px;">${paymentConfirm.simpleTitle}</h2>
        <p style="color:#475569;">${paymentConfirm.simpleBody}</p>
        ${emailTable([
          ["Invoice Number", invoice_number],
          [
            "Amount Paid",
            `${payment.amount} XAF`,
            "font-weight:700;color:#16a34a;font-size:15px;",
          ],
          [
            "Status",
            "&#10003;&nbsp;Paid &amp; Held in Escrow",
            "color:#16a34a;font-weight:600;",
          ],
        ])}
        <p style="color:#475569;">${paymentConfirm.receiptMessage}</p>
        ${emailButton(receiptDownloadLink, paymentConfirm.downloadButton)}
        <h3 style="color:#0F1F3D;margin:20px 0 8px;">${buyerLanguage === "fr" ? "Prochaine étape : confirmez votre livraison" : "Next Step: Confirm Your Delivery"}</h3>
        <p style="color:#475569;">${buyerLanguage === "fr" ? "Une fois que vous avez reçu votre article et que vous êtes satisfait, cliquez sur le bouton ci-dessous pour libérer les fonds au vendeur :" : "Once you have received your item and are satisfied, click the button below to release the funds to the seller:"}</p>
        ${emailButton(confirmationLink, paymentConfirm.confirmButton)}
        <p style="color:#475569;margin-top:4px;font-size:14px;">${paymentConfirm.codeMessage} <strong style="font-family:monospace;font-size:17px;letter-spacing:3px;color:#0F1F3D;">${finalCode}</strong></p>`,
        {
          footerNote:
            buyerLanguage === "fr"
              ? "Vous avez reçu cet e-mail parce qu'un paiement a été traité en votre nom via Fonlok Escrow. Ne partagez pas votre code de confirmation ou votre lien avec personne d'autre que le vendeur."
              : "You received this email because a payment was processed on your behalf through Fonlok Escrow. Do not share your confirmation code or link with anyone other than the seller.",
        },
      );
    } else {
      // ── Milestone/installment invoice: per-milestone release ──────────────
      // Fetch the milestone breakdown to include in the email.
      const milestonesData = await db.query(
        "SELECT milestone_number, label, amount FROM invoice_milestones WHERE invoice_id = $1 ORDER BY milestone_number ASC",
        [invoiceId],
      );
      const paymentConfirm = buildEmailCopy(buyerLanguage, "paymentConfirmed");
      buyerEmailSubject = paymentConfirm.subject(invoice_number);
      buyerEmailHtml = emailWrap(
        `<h2 style="color:#0F1F3D;margin:0 0 12px;">${paymentConfirm.milestoneTitle}</h2>
        <p style="color:#475569;">${paymentConfirm.milestoneBody(invoice_number)}</p>
        ${emailTable([
          ["Invoice Number", invoice_number],
          [
            buyerLanguage === "fr" ? "Total en séquestre" : "Total in Escrow",
            `${payment.amount} XAF`,
            "font-weight:700;color:#16a34a;font-size:15px;",
          ],
          [
            buyerLanguage === "fr" ? "Type de paiement" : "Payment Type",
            buyerLanguage === "fr"
              ? "Séquestre par jalons"
              : "Milestone Escrow",
          ],
          [
            buyerLanguage === "fr" ? "Statut" : "Status",
            buyerLanguage === "fr"
              ? "&#10003;&nbsp;Fonds conservés en séquestre"
              : "&#10003;&nbsp;Funds Held in Escrow",
            "color:#16a34a;font-weight:600;",
          ],
        ])}
        <h3 style="color:#0F1F3D;margin:20px 0 8px;">${paymentConfirm.milestoneHeader}</h3>
        <p style="color:#475569;margin-bottom:12px;">${paymentConfirm.milestoneNote}</p>
        ${emailTable(
          milestonesData.rows.map((m) => [
            buyerLanguage === "fr"
              ? `Jalon ${m.milestone_number}: ${m.label}`
              : `Milestone ${m.milestone_number}: ${m.label}`,
            `${Number(m.amount).toLocaleString()} XAF`,
          ]),
        )}
        <p style="color:#475569;margin-top:16px;">${paymentConfirm.receiptMessage}</p>
        ${emailButton(receiptDownloadLink, paymentConfirm.downloadButton)}
        <h3 style="color:#0F1F3D;margin:20px 0 8px;">${paymentConfirm.milestoneInstructions}</h3>
        <ol style="color:#475569;padding-left:20px;margin:0 0 20px;line-height:1.8;">
          <li>${paymentConfirm.step1}</li>
          <li>${paymentConfirm.step2}</li>
          <li>${paymentConfirm.step3}</li>
          <li>${paymentConfirm.step4}</li>
        </ol>
        <p style="color:#475569;font-size:13px;">${paymentConfirm.warning}</p>`,
        {
          footerNote:
            buyerLanguage === "fr"
              ? "Vous avez reçu cet e-mail parce qu'un paiement en séquestre basé sur les jalons a été traité en votre nom via Fonlok. Chaque jalon nécessite votre approbation explicite avant que les fonds ne soient libérés au vendeur."
              : "You received this email because a milestone-based escrow payment was processed on your behalf through Fonlok. Each milestone requires your explicit approval before any funds are released to the seller.",
        },
      );
    }

    const buyerMsg = {
      to: buyerEmail,
      from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
      subject: buyerEmailSubject,
      html: buyerEmailHtml,
      ...(buyerPdfAttachment ? { attachments: [buyerPdfAttachment] } : {}),
    };
    try {
      await sgMail.send(buyerMsg);
      console.log("âœ…  Confirmation email sent to buyer.");
    } catch (emailErr) {
      console.error(
        "âŒ  SendGrid (confirmation):",
        emailErr.response?.body ?? emailErr.message,
      );
    }
  }

  // 8. Create chat room + send chat invite
  const chatToken = crypto.randomBytes(32).toString("hex");
  await db.query("UPDATE guests SET chat_token = $1 WHERE invoicenumber = $2", [
    chatToken,
    invoice_number,
  ]);
  await db.query(
    "INSERT INTO chats (invoiceid, invoicenumber) VALUES ($1, $2) ON CONFLICT (invoicenumber) DO NOTHING",
    [invoiceId, invoice_number],
  );

  if (buyerEmail) {
    const buyerChatLink = `${process.env.FRONTEND_URL}/chat/${invoice_number}?token=${chatToken}`;
    const buyerDisputeLink = `${process.env.FRONTEND_URL}/chat/${invoice_number}?token=${chatToken}&dispute=true`;
    const chatCopy = buildEmailCopy(buyerLanguage, "chatInvite");
    const chatInviteMsg = {
      to: buyerEmail,
      from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
      subject: chatCopy.subject(invoice_number),
      html: emailWrap(
        `<h2 style="color:#0F1F3D;margin:0 0 12px;">${chatCopy.title}</h2>
        <p style="color:#475569;">${chatCopy.body(invoice_number)}</p>
        ${emailButton(buyerChatLink, chatCopy.chatButton)}
        <h3 style="color:#0F1F3D;margin:20px 0 8px;">${chatCopy.problemTitle}</h3>
        <p style="color:#475569;">${chatCopy.problemBody}</p>
        ${emailButtonDanger(buyerDisputeLink, chatCopy.disputeButton)}`,
        {
          footerNote: chatCopy.footerNote,
        },
      ),
    };
    try {
      await sgMail.send(chatInviteMsg);
      console.log("âœ…  Chat invite email sent to buyer.");
    } catch (chatEmailErr) {
      console.error(
        "âŒ  SendGrid (chat invite):",
        chatEmailErr.response?.body ?? chatEmailErr.message,
      );
    }
  }

  // 9. Notify seller - in-app bell + push + email
  // ─────────────────────────────────────────────────────────────────────────
  // In-app / push notification (non-fatal)
  notifyUser(
    idUser,
    "invoice_paid",
    "Invoice Paid - Deliver Now",
    `Invoice ${invoice_number} has been paid. ${payment.amount} XAF is secured in escrow. Please deliver what was ordered so funds can be released to you.`,
    { invoiceNumber: invoice_number, amount: payment.amount },
  );

  // Email notification to seller
  try {
    const sellerResult = await db.query(
      "SELECT email, name FROM users WHERE id = $1 LIMIT 1",
      [idUser],
    );
    if (sellerResult.rows.length > 0) {
      const seller = sellerResult.rows[0];
      const sellerLanguage = await getUserEmailLanguageByEmail(seller.email);
      const invoicePaidCopy = buildEmailCopy(sellerLanguage, "invoicePaid");
      const sellerDashboardLink = `${process.env.FRONTEND_URL}/dashboard`;
      const sellerChatLink = `${process.env.FRONTEND_URL}/chat/${invoice_number}`;
      const sellerFirstName = (seller.name || "there").split(" ")[0];
      // Buyer name from guests table (best-effort)
      let buyerName = "the buyer";
      try {
        const guestName = await db.query(
          "SELECT name FROM guests WHERE invoicenumber = $1 ORDER BY created_at DESC LIMIT 1",
          [invoice_number],
        );
        if (guestName.rows[0]?.name) buyerName = guestName.rows[0].name;
      } catch (_) {
        /* non-fatal */
      }

      const sellerMsg = {
        to: seller.email,
        from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
        subject: invoicePaidCopy.subject(invoice_number),
        html: emailWrap(
          `<h2 style="color:#0F1F3D;margin:0 0 12px;">${invoicePaidCopy.title}</h2>
          <p style="color:#475569;">${invoicePaidCopy.body(buyerName, sellerFirstName)}</p>
          <p style="color:#475569;margin-bottom:20px;">${sellerLanguage === "fr" ? "Votre prochaine étape est de livrer les biens ou services que vous avez promis. Une fois que l'acheteur confirme la réception, les fonds vous seront libérés directement." : "Your next step is to deliver the goods or service you promised. Once the buyer confirms receipt, the funds will be released directly to you."}</p>
          ${emailTable([
            ["Invoice Number", invoice_number],
            [
              sellerLanguage === "fr"
                ? "Montant en séquestre"
                : "Amount in Escrow",
              `${payment.amount} XAF`,
              "font-weight:700;color:#16a34a;font-size:15px;",
            ],
            [sellerLanguage === "fr" ? "Acheteur" : "Buyer", buyerName],
            [
              sellerLanguage === "fr" ? "Statut du séquestre" : "Escrow Status",
              sellerLanguage === "fr"
                ? "&#10003;&nbsp;Fonds sécurisés"
                : "&#10003;&nbsp;Funds Secured",
              "color:#16a34a;font-weight:600;",
            ],
          ])}
          <h3 style="color:#0F1F3D;margin:24px 0 8px;">${invoicePaidCopy.nextTitle}</h3>
          <ol style="color:#475569;padding-left:20px;margin:0 0 20px;line-height:1.8;">
            <li>${invoicePaidCopy.nextStep1}</li>
            <li>${invoicePaidCopy.nextStep2}</li>
            <li>${invoicePaidCopy.nextStep3}</li>
          </ol>
          ${emailButton(sellerChatLink, invoicePaidCopy.button)}
          ${emailButton(sellerDashboardLink, sellerLanguage === "fr" ? "Aller au tableau de bord" : "Go to Dashboard")}
          <p style="color:#94a3b8;font-size:13px;margin-top:20px;">${invoicePaidCopy.footer}</p>`,
          {
            footerNote:
              sellerLanguage === "fr"
                ? "Vous avez reçu cet e-mail parce que l'une de vos factures Fonlok a été payée. Ne partagez vos identifiants de compte avec personne."
                : "You received this email because one of your Fonlok invoices was paid. Do not share your account credentials with anyone.",
          },
        ),
      };
      await sgMail.send(sellerMsg);
      console.log("✅  Invoice-paid email sent to seller.");
    }
  } catch (sellerEmailErr) {
    console.error(
      "⚠️  Could not send invoice-paid email to seller:",
      sellerEmailErr.response?.body ?? sellerEmailErr.message,
    );
  }

  return "done";
}

// â”€â”€â”€ Route 1: Campay webhook â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post("/confirmation", async (req, res) => {
  const signature = req.body.signature;
  const paymentUUID = req.body.external_reference;
  const status = req.body.status;
  const webhookSecret = process.env.CAMPAY_WEBHOOK_KEY;

  try {
    jwt.verify(signature, webhookSecret);
    console.log("âœ…  Campay webhook signature verified.");

    if (status === "SUCCESSFUL") {
      const result = await processSuccessfulPayment(paymentUUID);
      console.log(`Webhook processing result: ${result}`);
    } else {
      console.log(`Payment status was ${status} - no action taken.`);
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("âŒ  Webhook error:", err.message);
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).send("Invalid Signature");
    }
    return res.status(500).send("Internal error");
  }
});

// â”€â”€â”€ Route 2: Frontend poll endpoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The payment-pending page calls this every 4 s.
// Fast path: if DB already says paid â†’ return immediately.
// Slow path: ask Campay API directly and process if SUCCESSFUL.
// This works even when the webhook can't reach the server (ngrok, firewall, etc.).
router.get("/poll/:invoice_number", async (req, res) => {
  const { invoice_number } = req.params;

  try {
    // Fast path - check DB first
    const invoiceResult = await db.query(
      "SELECT status FROM invoices WHERE invoicenumber = $1",
      [invoice_number],
    );
    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ status: "not_found" });
    }
    const dbStatus = invoiceResult.rows[0].status;
    if (["paid", "delivered", "completed"].includes(dbStatus)) {
      return res.json({ status: dbStatus });
    }

    // Slow path - get the latest payment UUID and ask Campay
    const paymentResult = await db.query(
      `SELECT p.* FROM payments p
       JOIN invoices i ON i.id = p.invoiceid
       WHERE i.invoicenumber = $1
       ORDER BY p.id DESC LIMIT 1`,
      [invoice_number],
    );
    if (paymentResult.rows.length === 0) {
      return res.json({ status: dbStatus });
    }
    const paymentUUID = paymentResult.rows[0].providerpaymentid;
    // Use Campay's own reference for the status check if available;
    // fall back to our UUID for older rows created before this fix.
    const campayRef = paymentResult.rows[0].campay_reference || paymentUUID;

    const campayAuthPoll = await axios.post(
      `${process.env.CAMPAY_BASE_URL}token/`,
      {
        username: process.env.CAMPAY_USERNAME,
        password: process.env.CAMPAY_PASSWORD,
      },
    );
    const txResponse = await axios.get(
      `${process.env.CAMPAY_BASE_URL}transaction/${campayRef}/`,
      { headers: { Authorization: `Token ${campayAuthPoll.data.token}` } },
    );
    const campayStatus = txResponse.data.status;
    console.log(
      `🔍 Poll [${invoice_number}]: Campay status = ${campayStatus} (ref: ${campayRef})`,
    );

    if (campayStatus === "SUCCESSFUL") {
      await processSuccessfulPayment(paymentUUID);
      return res.json({ status: "paid" });
    }

    return res.json({ status: dbStatus, campayStatus });
  } catch (err) {
    console.error(
      `❌ Poll error [${req.params.invoice_number}]:`,
      err.response?.data ?? err.message,
    );
    try {
      const fallback = await db.query(
        "SELECT status FROM invoices WHERE invoicenumber = $1",
        [invoice_number],
      );
      return res.json({ status: fallback.rows[0]?.status ?? "pending" });
    } catch {
      return res.json({ status: "pending" });
    }
  }
});

export default router;
