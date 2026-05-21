/**
 * generateReceiptPdf(invoice_number)
 *
 * Generates a branded Fonlok PDF receipt for any paid/delivered invoice.
 * Returns a Buffer containing the PDF bytes, or throws on error.
 *
 * Used by:
 *  - GET /invoice/receipt/:invoice_number  (download endpoint)
 *  - POST /payout/...                      (email attachment after seller payout)
 *  - Webhook confirmation                  (email attachment after buyer payment confirmed)
 */

import { PDFDocument, rgb, degrees, StandardFonts } from "pdf-lib";
import crypto from "crypto";
import db from "../controllers/db.js";
import { BRAND } from "../config/brand.js";

// ── Helper: draw text horizontally centred around a given cx ─────────────────
function drawCentred(page, text, { cx, y, size, font, color, opacity }) {
  const w = font.widthOfTextAtSize(text, size);
  const opts = { x: cx - w / 2, y, size, font, color };
  if (opacity !== undefined) opts.opacity = opacity;
  page.drawText(text, opts);
}

// ── Helper: right-align text so its right edge is at rx ──────────────────────
function drawRight(page, text, { rx, y, size, font, color }) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: rx - w, y, size, font, color });
}

function normalizePdfLocale(locale) {
  return String(locale || "en")
    .toLowerCase()
    .startsWith("fr")
    ? "fr"
    : "en";
}

const PDF_COPY = {
  en: {
    brandTagline: "Secure Escrow Payments",
    officialReceipt: "OFFICIAL PAYMENT RECEIPT",
    officialStatement: "TRANSACTION STATEMENT",
    receiptTitleFallback: "Payment Receipt",
    receiptNo: "Receipt No:",
    issued: "Issued:",
    paid: "Paid:",
    fromSeller: "FROM — SELLER",
    toBuyer: "TO — BUYER",
    totalAmountPaid: "TOTAL AMOUNT PAID",
    paymentType: "Payment Type",
    installmentMilestones: "Installment / Milestones",
    oneTime: "One-Time",
    description: "Description",
    currency: "Currency",
    invoiceStatus: "Invoice Status",
    expires: "Expires / Expired",
    milestoneBreakdown: "Milestone Breakdown",
    receiptVerification: "RECEIPT VERIFICATION",
    invoiceNo: "Invoice No:",
    verifyCode: "Verify Code:",
    verifyAt: "Enter at",
    footerReceipt:
      "Official payment receipt issued by Fonlok — Secure Escrow Payments for digital services.",
    footerReceipt2:
      "This document is cryptographically signed and does not require a physical signature.",
    footerStatement:
      "Official transaction statement issued by Fonlok — Secure Escrow Payments for digital services.",
    footerStatement2: "For account verification and dispute resolution.",
    statementTitle: "Account Transaction Statement",
    account: "Account:",
    email: "Email:",
    totalAmount: "Total Amount",
    transactions: "Transactions",
    successful: "Successful",
    transactionDetails: "Transaction Details",
    date: "Date",
    descriptionCol: "Description",
    amount: "Amount",
    status: "Status",
    transactionFallback: "Transaction",
    payoutReceived: "Payout received",
    pending: "Pending",
    released: "Released",
    completed: "Completed",
    delivered: "Delivered",
    paid: "Paid",
    success: "Success",
    failed: "Failed",
    moreTransactions: "... and",
    moreTransactionsTail: "more transactions",
    verified: "VERIFIED",
    secureEscrow: "SECURE ESCROW",
    statusText: (status) =>
      ({
        paid: "Paid",
        delivered: "Delivered",
        completed: "Completed",
        pending: "Pending",
        released: "Released",
        success: "Success",
        failed: "Failed",
      })[status] || status.charAt(0).toUpperCase() + status.slice(1),
  },
  fr: {
    brandTagline: "Paiements sécurisés par séquestre",
    officialReceipt: "REÇU DE PAIEMENT OFFICIEL",
    officialStatement: "RELEVÉ DE TRANSACTIONS",
    receiptTitleFallback: "Reçu de paiement",
    receiptNo: "N° de reçu :",
    issued: "Émis le :",
    paid: "Payé le :",
    fromSeller: "DE — VENDEUR",
    toBuyer: "À — ACHETEUR",
    totalAmountPaid: "MONTANT TOTAL PAYÉ",
    paymentType: "Type de paiement",
    installmentMilestones: "Versement / Jalons",
    oneTime: "Unique",
    description: "Description",
    currency: "Devise",
    invoiceStatus: "Statut de la facture",
    expires: "Expire / Expiré",
    milestoneBreakdown: "Répartition des jalons",
    receiptVerification: "VÉRIFICATION DU REÇU",
    invoiceNo: "N° de facture :",
    verifyCode: "Code de vérification :",
    verifyAt: "Saisir sur",
    footerReceipt:
      "Reçu de paiement officiel émis par Fonlok — Paiements sécurisés par séquestre pour les services numériques.",
    footerReceipt2:
      "Ce document est signé cryptographiquement et ne nécessite pas de signature physique.",
    footerStatement:
      "Relevé de transactions officiel émis par Fonlok — Paiements sécurisés par séquestre pour les services numériques.",
    footerStatement2:
      "Pour la vérification du compte et la résolution des litiges.",
    statementTitle: "Relevé de transactions du compte",
    account: "Compte :",
    email: "E-mail :",
    totalAmount: "Montant total",
    transactions: "Transactions",
    successful: "Réussies",
    transactionDetails: "Détails des transactions",
    date: "Date",
    descriptionCol: "Description",
    amount: "Montant",
    status: "Statut",
    transactionFallback: "Transaction",
    payoutReceived: "Paiement reçu",
    pending: "En attente",
    released: "Libéré",
    completed: "Terminé",
    delivered: "Livré",
    paid: "Payé",
    success: "Réussie",
    failed: "Échouée",
    moreTransactions: "... et",
    moreTransactionsTail: "transactions supplémentaires",
    verified: "VÉRIFIÉ",
    secureEscrow: "SÉQUESTRE SÉCURISÉ",
    statusText: (status) =>
      ({
        paid: "Payé",
        delivered: "Livré",
        completed: "Terminé",
        pending: "En attente",
        released: "Libéré",
        success: "Réussie",
        failed: "Échouée",
      })[status] || status.charAt(0).toUpperCase() + status.slice(1),
  },
};

export async function generateReceiptPdf(invoice_number, locale = "en") {
  const pdfLocale = normalizePdfLocale(locale);
  const copy = PDF_COPY[pdfLocale];
  const dateLocale = pdfLocale === "fr" ? "fr-FR" : "en-GB";
  // ── 1. Invoice + seller ────────────────────────────────────────────────────
  const invResult = await db.query(
    `SELECT i.*, u.name AS seller_name, u.username AS seller_username,
            u.phone AS seller_phone, u.country AS seller_country
     FROM invoices i
     JOIN users u ON u.id = i.userid
     WHERE i.invoicenumber = $1`,
    [invoice_number],
  );
  if (invResult.rows.length === 0)
    throw new Error(`Invoice ${invoice_number} not found`);
  const inv = invResult.rows[0];

  if (!["paid", "delivered", "completed"].includes(inv.status))
    throw new Error(
      `Receipt not available — invoice ${invoice_number} has status "${inv.status}"`,
    );

  // ── 2. Milestones ──────────────────────────────────────────────────────────
  let milestones = [];
  if (inv.payment_type === "installment") {
    const msResult = await db.query(
      `SELECT milestone_number, label, amount, status
       FROM invoice_milestones WHERE invoice_id = $1
       ORDER BY milestone_number ASC`,
      [inv.id],
    );
    milestones = msResult.rows;
  }

  // ── 3. Buyer info (join users if a registered account) ────────────────────
  const buyerResult = await db.query(
    `SELECT g.email, g.momo_number, u.name AS buyer_name
     FROM guests g
     LEFT JOIN users u ON u.id = g.user_id
     WHERE g.invoicenumber = $1
     ORDER BY g.created_at DESC LIMIT 1`,
    [invoice_number],
  );
  const buyer = buyerResult.rows[0] || null;
  const buyerName = buyer?.buyer_name || null;
  const buyerEmail = buyer?.email || inv.clientemail || null;
  const buyerPhone = buyer?.momo_number ? `+${buyer.momo_number}` : null;

  // ── Build PDF ──────────────────────────────────────────────────────────────
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const { width, height } = page.getSize();
  const margin = 40;
  const contentW = width - margin * 2;

  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // ── Palette ───────────────────────────────────────────────────────────────
  const navy = rgb(0.059, 0.122, 0.239); // #0F1F3D
  const amber = rgb(0.961, 0.62, 0.043); // #F59E0B
  const white = rgb(1, 1, 1);
  const iceBlue = rgb(0.93, 0.96, 1.0);
  const lightGray = rgb(0.95, 0.95, 0.96);
  const darkText = rgb(0.12, 0.14, 0.18);
  const mutedText = rgb(0.45, 0.47, 0.52);
  const green = rgb(0.1, 0.5, 0.1);

  // ═══════════════════════════════════════════════════════════════════════════
  // ── HEADER BAR ────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  const headerH = 96;
  page.drawRectangle({
    x: 0,
    y: height - headerH,
    width,
    height: headerH,
    color: navy,
  });

  // Amber accent stripe at the very bottom of the header
  page.drawRectangle({
    x: 0,
    y: height - headerH,
    width,
    height: 3,
    color: amber,
  });

  // Logo: "F" box
  const logoSize = 38;
  const logoX = margin;
  const logoY = height - headerH + (headerH - logoSize) / 2;
  page.drawRectangle({
    x: logoX,
    y: logoY,
    width: logoSize,
    height: logoSize,
    color: amber,
    borderRadius: 6,
  });
  drawCentred(page, "F", {
    cx: logoX + logoSize / 2,
    y: logoY + (logoSize - 24) / 2 + 2,
    size: 24,
    font: bold,
    color: navy,
  });

  // Wordmark "Fonlok" + tagline beside the box
  const wordmarkX = logoX + logoSize + 10;
  page.drawText("Fonlok", {
    x: wordmarkX,
    y: height - headerH + (headerH - 20) / 2 + 14,
    size: 22,
    font: bold,
    color: amber,
  });
  page.drawText(copy.brandTagline, {
    x: wordmarkX,
    y: height - headerH + (headerH - 20) / 2 - 2,
    size: 8.5,
    font: regular,
    color: rgb(0.7, 0.78, 0.9),
  });

  // Right side: "OFFICIAL PAYMENT RECEIPT" + "fonlok.com" right-aligned
  drawRight(page, copy.officialReceipt, {
    rx: width - margin,
    y: height - headerH + (headerH - 10) / 2 + 14,
    size: 11,
    font: bold,
    color: white,
  });
  drawRight(page, BRAND.domain, {
    rx: width - margin,
    y: height - headerH + (headerH - 10) / 2 - 2,
    size: 8.5,
    font: regular,
    color: rgb(0.7, 0.78, 0.9),
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── INVOICE TITLE SECTION ─────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  const titleY = height - headerH - 36;

  page.drawText(inv.invoicename || copy.receiptTitleFallback, {
    x: margin,
    y: titleY,
    size: 17,
    font: bold,
    color: darkText,
  });

  // Receipt No right-aligned
  drawRight(page, `${copy.receiptNo}  ${invoice_number}`, {
    rx: width - margin,
    y: titleY,
    size: 9,
    font: bold,
    color: navy,
  });

  const issuedDate = inv.createdat
    ? new Date(inv.createdat).toLocaleDateString(dateLocale, {
        day: "2-digit",
        month: "long",
        year: "numeric",
      })
    : "—";
  const paidDate = inv.paid_at
    ? new Date(inv.paid_at).toLocaleDateString(dateLocale, {
        day: "2-digit",
        month: "long",
        year: "numeric",
      })
    : "—";

  page.drawText(`${copy.issued} ${issuedDate}`, {
    x: margin,
    y: titleY - 16,
    size: 8.5,
    font: regular,
    color: mutedText,
  });

  drawRight(page, `${copy.paid} ${paidDate}`, {
    rx: width - margin,
    y: titleY - 16,
    size: 8.5,
    font: regular,
    color: mutedText,
  });

  // Amber underline
  const divY1 = titleY - 26;
  page.drawRectangle({
    x: margin,
    y: divY1,
    width: contentW,
    height: 1.5,
    color: amber,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── SELLER / BUYER BOXES ──────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  const boxTopY = divY1 - 100;
  const boxH = 92;
  const colW = (contentW - 12) / 2;

  function drawPartyBox(x, label, name, sub1, sub2, sub3) {
    page.drawRectangle({
      x,
      y: boxTopY,
      width: colW,
      height: boxH,
      color: iceBlue,
      borderRadius: 5,
    });
    // Accent left bar
    page.drawRectangle({
      x,
      y: boxTopY,
      width: 3,
      height: boxH,
      color: navy,
      borderRadius: 5,
    });

    page.drawText(label, {
      x: x + 12,
      y: boxTopY + boxH - 16,
      size: 7.5,
      font: bold,
      color: navy,
    });
    if (name)
      page.drawText(name.substring(0, 32), {
        x: x + 12,
        y: boxTopY + boxH - 32,
        size: 10,
        font: bold,
        color: darkText,
      });
    if (sub1)
      page.drawText(sub1.substring(0, 36), {
        x: x + 12,
        y: boxTopY + boxH - 47,
        size: 8.5,
        font: regular,
        color: mutedText,
      });
    if (sub2)
      page.drawText(sub2.substring(0, 36), {
        x: x + 12,
        y: boxTopY + boxH - 60,
        size: 8.5,
        font: regular,
        color: mutedText,
      });
    if (sub3)
      page.drawText(sub3.substring(0, 36), {
        x: x + 12,
        y: boxTopY + boxH - 73,
        size: 8.5,
        font: regular,
        color: mutedText,
      });
  }

  drawPartyBox(
    margin,
    copy.fromSeller,
    inv.seller_name || "—",
    inv.seller_username ? `@${inv.seller_username}` : null,
    inv.seller_phone ? `+${inv.seller_phone}` : null,
    inv.seller_country || null,
  );

  drawPartyBox(
    margin + colW + 12,
    copy.toBuyer,
    buyerName || buyerEmail || "—",
    buyerName ? buyerEmail : null, // show email as sub-line only if we already showed a name
    buyerPhone,
    null,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ── TOTAL AMOUNT BAR ──────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  const amtBarY = boxTopY - 46;
  const amtBarH = 42;
  page.drawRectangle({
    x: margin,
    y: amtBarY,
    width: contentW,
    height: amtBarH,
    color: navy,
    borderRadius: 5,
  });

  // Label + amount left side
  page.drawText(copy.totalAmountPaid, {
    x: margin + 14,
    y: amtBarY + amtBarH - 14,
    size: 7.5,
    font: bold,
    color: rgb(0.65, 0.74, 0.88),
  });
  page.drawText(`${Number(inv.amount).toLocaleString()} ${inv.currency}`, {
    x: margin + 14,
    y: amtBarY + 8,
    size: 16,
    font: bold,
    color: amber,
  });

  // Status pill right side — centred vertically in bar
  const statusLabel = copy.statusText(inv.status).toUpperCase();
  const pillW = bold.widthOfTextAtSize(statusLabel, 9) + 20;
  const pillX = width - margin - pillW - 4;
  const pillY = amtBarY + (amtBarH - 18) / 2;
  page.drawRectangle({
    x: pillX,
    y: pillY,
    width: pillW,
    height: 18,
    color: green,
    borderRadius: 9,
  });
  drawCentred(page, statusLabel, {
    cx: pillX + pillW / 2,
    y: pillY + 4.5,
    size: 8,
    font: bold,
    color: white,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── DETAILS TABLE ─────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  const tableY = amtBarY - 14;
  const rowH = 22;
  const labelColW = 160;

  // Helper: split text into lines that fit within maxWidth
  function wrapText(text, font, size, maxWidth) {
    const words = text.split(" ");
    const lines = [];
    let current = "";
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [""];
  }

  const valColX = margin + labelColW;
  const valColW = contentW - labelColW - 10;
  const descText = inv.description || "—";
  const descLines = wrapText(descText, regular, 9, valColW);
  const lineH = 13;
  const descRowH = Math.max(rowH, descLines.length * lineH + 9);

  const tableRows = [
    [
      copy.paymentType,
      inv.payment_type === "installment"
        ? copy.installmentMilestones
        : copy.oneTime,
      false,
    ],
    [copy.description, null, true],
    [copy.currency, inv.currency, false],
    [copy.invoiceStatus, copy.statusText(inv.status), false],
  ];
  if (inv.expires_at)
    tableRows.push([
      copy.expires,
      new Date(inv.expires_at).toLocaleDateString(dateLocale),
      false,
    ]);

  let tableAnchorY = tableY;
  tableRows.forEach(([label, val, isDesc], i) => {
    const thisRowH = isDesc ? descRowH : rowH;
    const ry = tableAnchorY;
    if (i % 2 === 0)
      page.drawRectangle({
        x: margin,
        y: ry + 16 - thisRowH,
        width: contentW,
        height: thisRowH,
        color: lightGray,
        borderRadius: 2,
      });
    page.drawText(label, {
      x: margin + 10,
      y: ry + 5,
      size: 8.5,
      font: bold,
      color: mutedText,
    });
    if (isDesc) {
      descLines.forEach((line, li) => {
        page.drawText(line, {
          x: valColX,
          y: ry + 5 - li * lineH,
          size: 9,
          font: regular,
          color: darkText,
        });
      });
    } else {
      page.drawText(val, {
        x: valColX,
        y: ry + 5,
        size: 9,
        font: regular,
        color: darkText,
      });
    }
    tableAnchorY -= thisRowH;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── MILESTONES TABLE ──────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  let cursorY = tableAnchorY - 24;

  if (milestones.length > 0) {
    page.drawText(copy.milestoneBreakdown, {
      x: margin,
      y: cursorY,
      size: 10,
      font: bold,
      color: darkText,
    });
    cursorY -= 16;

    // Header row
    page.drawRectangle({
      x: margin,
      y: cursorY - 6,
      width: contentW,
      height: 20,
      color: navy,
      borderRadius: 3,
    });
    for (const [text, cx] of [
      ["#", margin + 18],
      [copy.descriptionCol, margin + 70],
      [copy.amount, margin + 320],
      [copy.status, margin + 430],
    ]) {
      drawCentred(page, text, {
        cx,
        y: cursorY + 3,
        size: 7.5,
        font: bold,
        color: white,
      });
    }
    cursorY -= rowH;

    milestones.forEach((ms, i) => {
      if (i % 2 === 0)
        page.drawRectangle({
          x: margin,
          y: cursorY - 6,
          width: contentW,
          height: rowH,
          color: lightGray,
        });
      page.drawText(String(ms.milestone_number), {
        x: margin + 10,
        y: cursorY + 5,
        size: 8,
        font: regular,
        color: darkText,
      });
      page.drawText((ms.label || "").substring(0, 30), {
        x: margin + 30,
        y: cursorY + 5,
        size: 8,
        font: regular,
        color: darkText,
      });
      page.drawText(`${Number(ms.amount).toLocaleString()} ${inv.currency}`, {
        x: margin + 295,
        y: cursorY + 5,
        size: 8,
        font: regular,
        color: darkText,
      });
      page.drawText(copy.statusText(ms.status || "—"), {
        x: margin + 415,
        y: cursorY + 5,
        size: 8,
        font: regular,
        color: ms.status === "released" ? green : darkText,
      });
      cursorY -= rowH;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── DIAGONAL WATERMARK — drawn after all bg fills so it sits on top ────────
  // ═══════════════════════════════════════════════════════════════════════════
  const wmText = "SECURED BY FONLOK";
  const wmSize = 58;
  const wmAngle = 38; // degrees
  const wmRad = (wmAngle * Math.PI) / 180;
  const wmW = bold.widthOfTextAtSize(wmText, wmSize);
  const wmX = width / 2 - (wmW / 2) * Math.cos(wmRad);
  const wmY = height / 2 - (wmW / 2) * Math.sin(wmRad);
  page.drawText(wmText, {
    x: wmX,
    y: wmY,
    size: wmSize,
    font: bold,
    color: navy,
    opacity: 0.055,
    rotate: degrees(wmAngle),
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── ELEGANT VERIFICATION SEAL (bottom-right, truly centred text) ──────────
  // ═══════════════════════════════════════════════════════════════════════════
  const sealCX = width - margin - 54; // horizontal centre of seal
  const sealCY = 136; // vertical centre of seal
  const sealR1 = 50; // outer radius
  const sealR2 = 38; // inner ring radius

  // Outer disc: solid navy
  page.drawCircle({
    x: sealCX,
    y: sealCY,
    size: sealR1,
    color: navy,
    borderColor: amber,
    borderWidth: 2,
  });
  // Inner ring: amber thin
  page.drawCircle({
    x: sealCX,
    y: sealCY,
    size: sealR2,
    color: navy,
    borderColor: amber,
    borderWidth: 0.8,
  });

  // "VERIFIED" centred top
  drawCentred(page, "VERIFIED", {
    cx: sealCX,
    y: sealCY + 20,
    size: 7.5,
    font: bold,
    color: amber,
  });
  // Decorative row of dots
  drawCentred(page, "· · · · ·", {
    cx: sealCX,
    y: sealCY + 10,
    size: 6,
    font: regular,
    color: rgb(0.7, 0.78, 0.9),
  });
  // "FONLOK" large centred
  drawCentred(page, "FONLOK", {
    cx: sealCX,
    y: sealCY - 4,
    size: 13,
    font: bold,
    color: white,
  });
  // Amber thin separator line
  const sepHalf = 22;
  page.drawLine({
    start: { x: sealCX - sepHalf, y: sealCY - 10 },
    end: { x: sealCX + sepHalf, y: sealCY - 10 },
    thickness: 0.6,
    color: amber,
  });
  // "SECURE ESCROW" small centred
  drawCentred(page, "SECURE ESCROW", {
    cx: sealCX,
    y: sealCY - 21,
    size: 6,
    font: bold,
    color: rgb(0.7, 0.78, 0.9),
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── VERIFICATION BLOCK (left of seal) ─────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  const hash = crypto
    .createHash("sha256")
    .update(invoice_number + (process.env.JWT_SECRET || "fonlok"))
    .digest("hex")
    .substring(0, 16)
    .toUpperCase();
  const codeFormatted = hash.match(/.{1,4}/g)?.join("  ") ?? hash;

  const vbX = margin;
  const vbY = 97;
  const vbW = width - margin * 2 - sealR1 * 2 - 20; // stop before the seal
  const vbH = 58;
  page.drawRectangle({
    x: vbX,
    y: vbY,
    width: vbW,
    height: vbH,
    color: iceBlue,
    borderColor: navy,
    borderWidth: 0.5,
    borderRadius: 5,
  });

  page.drawText(copy.receiptVerification, {
    x: vbX + 12,
    y: vbY + vbH - 15,
    size: 7,
    font: bold,
    color: navy,
  });
  page.drawLine({
    start: { x: vbX + 12, y: vbY + vbH - 19 },
    end: { x: vbX + vbW - 12, y: vbY + vbH - 19 },
    thickness: 0.4,
    color: navy,
  });
  page.drawText(`${copy.invoiceNo}   ${invoice_number}`, {
    x: vbX + 12,
    y: vbY + vbH - 31,
    size: 8,
    font: regular,
    color: darkText,
  });
  page.drawText(`${copy.verifyCode}  ${codeFormatted}`, {
    x: vbX + 12,
    y: vbY + vbH - 44,
    size: 8.5,
    font: bold,
    color: navy,
  });
  page.drawText(
    `${copy.verifyAt}  ${BRAND.domain}/verify  ${pdfLocale === "fr" ? "pour confirmer que ce reçu est authentique et non modifié." : "to confirm this receipt is authentic and unaltered."}`,
    {
      x: vbX + 12,
      y: vbY + 8,
      size: 6.5,
      font: regular,
      color: mutedText,
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ── FOOTER ────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  const footerY = 82;
  page.drawRectangle({ x: 0, y: 0, width, height: footerY, color: navy });
  page.drawRectangle({ x: 0, y: footerY, width, height: 1.5, color: amber });

  drawCentred(page, copy.footerReceipt, {
    cx: width / 2,
    y: 58,
    size: 7,
    font: regular,
    color: rgb(0.7, 0.78, 0.9),
  });
  drawCentred(page, `${copy.footerReceipt2}  |  ${BRAND.domain}`, {
    cx: width / 2,
    y: 44,
    size: 6.5,
    font: regular,
    color: rgb(0.55, 0.63, 0.76),
  });
  drawCentred(
    page,
    `${pdfLocale === "fr" ? "Généré" : "Generated"}: ${new Date().toUTCString()}`,
    {
      cx: width / 2,
      y: 28,
      size: 6.5,
      font: regular,
      color: rgb(0.5, 0.58, 0.72),
    },
  );

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/**
 * generateStatementPdf(userId, startDate, endDate)
 *
 * Generates a branded Fonlok transaction statement PDF for a given date range.
 * Returns a Buffer containing the PDF bytes, or throws on error.
 *
 * Used by:
 *  - GET /transactions/statement  (download endpoint)
 */
export async function generateStatementPdf(
  userId,
  startDate,
  endDate,
  locale = "en",
) {
  const pdfLocale = normalizePdfLocale(locale);
  const copy = PDF_COPY[pdfLocale];
  const dateLocale = pdfLocale === "fr" ? "fr-FR" : "en-GB";
  // ── Fetch transactions for the date range ──────────────────────────────────
  const txResult = await db.query(
    `SELECT id, amount, currency, status, createdat, invoicename, invoicenumber
     FROM (
       SELECT 
         id,
         amount,
         'XAF' AS currency,
         status,
         createdat,
         'Payout received' AS invoicename,
         userid,
         '' AS invoicenumber
       FROM payouts
       WHERE userid = $1
       UNION ALL
       SELECT 
         payments.id,
         payments.amount,
         invoices.currency,
         payments.status,
         payments.createdat,
         invoices.invoicename,
         guests.registered_userid as userid,
         invoices.invoicenumber
       FROM payments
       JOIN invoices ON invoices.id = payments.invoiceid
       JOIN guests ON guests.invoicenumber = invoices.invoicenumber
       WHERE guests.registered_userid = $1
     ) AS all_transactions
     WHERE createdat >= $2 AND createdat < $3
     ORDER BY createdat DESC`,
    [userId, startDate, endDate],
  );
  const transactions = txResult.rows;

  // ── Fetch user info for statement header ───────────────────────────────────
  const userResult = await db.query(
    `SELECT name, username, email FROM users WHERE id = $1`,
    [userId],
  );
  if (userResult.rows.length === 0) throw new Error(`User ${userId} not found`);
  const user = userResult.rows[0];

  // ── Build PDF ──────────────────────────────────────────────────────────────
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const { width, height } = page.getSize();
  const margin = 40;
  const contentW = width - margin * 2;

  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // ── Palette (same as receipt) ──────────────────────────────────────────────
  const navy = rgb(0.059, 0.122, 0.239); // #0F1F3D
  const amber = rgb(0.961, 0.62, 0.043); // #F59E0B
  const white = rgb(1, 1, 1);
  const iceBlue = rgb(0.93, 0.96, 1.0);
  const lightGray = rgb(0.95, 0.95, 0.96);
  const darkText = rgb(0.12, 0.14, 0.18);
  const mutedText = rgb(0.45, 0.47, 0.52);
  const green = rgb(0.1, 0.5, 0.1);

  // ═══════════════════════════════════════════════════════════════════════════
  // ── HEADER BAR (same style as receipt) ─────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  const headerH = 96;
  page.drawRectangle({
    x: 0,
    y: height - headerH,
    width,
    height: headerH,
    color: navy,
  });
  page.drawRectangle({
    x: 0,
    y: height - headerH,
    width,
    height: 3,
    color: amber,
  });

  // Logo: "F" box
  const logoSize = 38;
  const logoX = margin;
  const logoY = height - headerH + (headerH - logoSize) / 2;
  page.drawRectangle({
    x: logoX,
    y: logoY,
    width: logoSize,
    height: logoSize,
    color: amber,
    borderRadius: 6,
  });
  drawCentred(page, "F", {
    cx: logoX + logoSize / 2,
    y: logoY + (logoSize - 24) / 2 + 2,
    size: 24,
    font: bold,
    color: navy,
  });

  // Wordmark "Fonlok" + tagline
  const wordmarkX = logoX + logoSize + 10;
  page.drawText("Fonlok", {
    x: wordmarkX,
    y: height - headerH + (headerH - 20) / 2 + 14,
    size: 22,
    font: bold,
    color: amber,
  });
  page.drawText(copy.brandTagline, {
    x: wordmarkX,
    y: height - headerH + (headerH - 20) / 2 - 2,
    size: 8.5,
    font: regular,
    color: rgb(0.7, 0.78, 0.9),
  });

  // Right side: "TRANSACTION STATEMENT" + domain
  drawRight(page, copy.officialStatement, {
    rx: width - margin,
    y: height - headerH + (headerH - 10) / 2 + 14,
    size: 11,
    font: bold,
    color: white,
  });
  drawRight(page, BRAND.domain, {
    rx: width - margin,
    y: height - headerH + (headerH - 10) / 2 - 2,
    size: 8.5,
    font: regular,
    color: rgb(0.7, 0.78, 0.9),
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── STATEMENT TITLE SECTION ────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  const titleY = height - headerH - 36;

  page.drawText(copy.statementTitle, {
    x: margin,
    y: titleY,
    size: 17,
    font: bold,
    color: darkText,
  });

  // Period on the right
  const startFormatted = new Date(startDate).toLocaleDateString(dateLocale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const endFormatted = new Date(endDate).toLocaleDateString(dateLocale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  drawRight(page, `${startFormatted} — ${endFormatted}`, {
    rx: width - margin,
    y: titleY,
    size: 9,
    font: bold,
    color: navy,
  });

  // Account info below
  page.drawText(`${copy.account} ${user.name} (@${user.username})`, {
    x: margin,
    y: titleY - 16,
    size: 8.5,
    font: regular,
    color: mutedText,
  });

  drawRight(page, `${copy.email} ${user.email || "—"}`, {
    rx: width - margin,
    y: titleY - 16,
    size: 8.5,
    font: regular,
    color: mutedText,
  });

  // Amber underline
  const divY1 = titleY - 26;
  page.drawRectangle({
    x: margin,
    y: divY1,
    width: contentW,
    height: 1.5,
    color: amber,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── SUMMARY STATS ──────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  const totalAmount = transactions.reduce(
    (sum, tx) => sum + Number(tx.amount),
    0,
  );
  const successCount = transactions.filter(
    (tx) => tx.status === "success" || tx.status === "paid",
  ).length;

  const statsY = divY1 - 50;
  const statBoxW = (contentW - 12) / 3;

  function drawStatBox(x, label, value, unit = "") {
    page.drawRectangle({
      x,
      y: statsY - 50,
      width: statBoxW,
      height: 50,
      color: iceBlue,
      borderRadius: 5,
    });
    page.drawText(label, {
      x: x + 12,
      y: statsY - 20,
      size: 7.5,
      font: bold,
      color: navy,
    });
    page.drawText(`${value.toLocaleString()}${unit}`, {
      x: x + 12,
      y: statsY - 38,
      size: 12,
      font: bold,
      color: darkText,
    });
  }

  drawStatBox(margin, copy.totalAmount, totalAmount, " XAF");
  drawStatBox(
    margin + statBoxW + 6,
    copy.transactions,
    transactions.length,
    "",
  );
  drawStatBox(margin + statBoxW * 2 + 12, copy.successful, successCount, "");

  // ═══════════════════════════════════════════════════════════════════════════
  // ── TRANSACTIONS TABLE ─────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  let cursorY = statsY - 70;

  page.drawText(copy.transactionDetails, {
    x: margin,
    y: cursorY,
    size: 10,
    font: bold,
    color: darkText,
  });
  cursorY -= 16;

  // Table header
  const headerY = cursorY;
  page.drawRectangle({
    x: margin,
    y: headerY - 20,
    width: contentW,
    height: 20,
    color: navy,
    borderRadius: 3,
  });

  const colPositions = [
    { label: copy.date, cx: margin + 60 },
    { label: copy.descriptionCol, cx: margin + 200 },
    { label: copy.amount, cx: margin + 380 },
    { label: copy.status, cx: margin + 480 },
  ];

  colPositions.forEach(({ label, cx }) => {
    drawCentred(page, label, {
      cx,
      y: headerY - 10,
      size: 7.5,
      font: bold,
      color: white,
    });
  });

  cursorY = headerY - 22;
  const rowH = 18;
  const PAGE_BOTTOM = 102; // height reserved for footer (82px) + buffer

  // ── Multi-page helpers ────────────────────────────────────────────────────
  let currentPage = page;
  let pageNum = 1;

  function drawPageFooter(p) {
    const footerH = 82;
    p.drawRectangle({ x: 0, y: 0, width, height: footerH, color: navy });
    p.drawRectangle({ x: 0, y: footerH, width, height: 1.5, color: amber });
    drawCentred(p, copy.footerStatement, {
      cx: width / 2,
      y: 58,
      size: 7,
      font: regular,
      color: rgb(0.7, 0.78, 0.9),
    });
    drawCentred(p, `${copy.footerStatement2}  |  ${BRAND.domain}`, {
      cx: width / 2,
      y: 44,
      size: 6.5,
      font: regular,
      color: rgb(0.55, 0.63, 0.76),
    });
    drawCentred(p, `Generated: ${new Date().toUTCString()}`, {
      cx: width / 2,
      y: 28,
      size: 6.5,
      font: regular,
      color: rgb(0.5, 0.58, 0.72),
    });
    drawCentred(p, `Page ${pageNum}`, {
      cx: width / 2,
      y: 14,
      size: 6.5,
      font: regular,
      color: rgb(0.5, 0.58, 0.72),
    });
  }

  function drawTableRowHeader(p, startY) {
    p.drawRectangle({
      x: margin,
      y: startY - 20,
      width: contentW,
      height: 20,
      color: navy,
      borderRadius: 3,
    });
    colPositions.forEach(({ label, cx }) => {
      drawCentred(p, label, {
        cx,
        y: startY - 10,
        size: 7.5,
        font: bold,
        color: white,
      });
    });
    return startY - 22;
  }

  function addNewPage() {
    pageNum++;
    const p = pdfDoc.addPage([595.28, 841.89]);
    const miniH = 40;
    p.drawRectangle({
      x: 0,
      y: height - miniH,
      width,
      height: miniH,
      color: navy,
    });
    p.drawRectangle({
      x: 0,
      y: height - miniH,
      width,
      height: 2,
      color: amber,
    });
    p.drawText("Fonlok", {
      x: margin,
      y: height - miniH + (miniH - 14) / 2,
      size: 14,
      font: bold,
      color: amber,
    });
    drawRight(p, copy.officialStatement, {
      rx: width - margin,
      y: height - miniH + (miniH - 9) / 2,
      size: 9,
      font: bold,
      color: white,
    });
    currentPage = p;
    let y = height - miniH - 16;
    p.drawText(`${copy.transactionDetails} (cont.)`, {
      x: margin,
      y,
      size: 9,
      font: bold,
      color: darkText,
    });
    y -= 12;
    return drawTableRowHeader(p, y);
  }

  // ── Table rows (paginated) ────────────────────────────────────────────────
  transactions.forEach((tx, i) => {
    // Start a new page when too close to footer
    if (cursorY - rowH < PAGE_BOTTOM) {
      drawPageFooter(currentPage);
      cursorY = addNewPage();
    }

    // Alternating row background
    if (i % 2 === 0) {
      currentPage.drawRectangle({
        x: margin,
        y: cursorY - rowH,
        width: contentW,
        height: rowH,
        color: lightGray,
      });
    }

    const txDate = new Date(tx.createdat).toLocaleDateString(dateLocale, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });

    currentPage.drawText(txDate, {
      x: margin + 10,
      y: cursorY - 13,
      size: 8,
      font: regular,
      color: darkText,
    });

    const desc = (
      tx.invoicename === "Payout received"
        ? copy.payoutReceived
        : tx.invoicename || tx.invoicenumber || copy.transactionFallback
    ).substring(0, 25);

    currentPage.drawText(desc, {
      x: margin + 125,
      y: cursorY - 13,
      size: 8,
      font: regular,
      color: darkText,
    });

    currentPage.drawText(
      `${Number(tx.amount).toLocaleString()} ${tx.currency}`,
      {
        x: margin + 330,
        y: cursorY - 13,
        size: 8,
        font: regular,
        color: darkText,
      },
    );

    const statusLabel = copy.statusText(tx.status || "pending");
    const statusColor =
      tx.status === "success" || tx.status === "paid" ? green : mutedText;
    currentPage.drawText(statusLabel, {
      x: margin + 440,
      y: cursorY - 13,
      size: 8,
      font: regular,
      color: statusColor,
    });

    cursorY -= rowH;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── VERIFICATION SEAL (bottom-right of last page) ──────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  const sealCX = width - margin - 54;
  const sealCY = 136;
  const sealR1 = 50;
  const sealR2 = 38;

  currentPage.drawCircle({
    x: sealCX,
    y: sealCY,
    size: sealR1,
    color: navy,
    borderColor: amber,
    borderWidth: 2,
  });
  currentPage.drawCircle({
    x: sealCX,
    y: sealCY,
    size: sealR2,
    color: navy,
    borderColor: amber,
    borderWidth: 0.8,
  });

  drawCentred(currentPage, "VERIFIED", {
    cx: sealCX,
    y: sealCY + 20,
    size: 7.5,
    font: bold,
    color: amber,
  });
  drawCentred(currentPage, "· · · · ·", {
    cx: sealCX,
    y: sealCY + 10,
    size: 6,
    font: regular,
    color: rgb(0.7, 0.78, 0.9),
  });
  drawCentred(currentPage, "FONLOK", {
    cx: sealCX,
    y: sealCY - 4,
    size: 13,
    font: bold,
    color: white,
  });
  currentPage.drawLine({
    start: { x: sealCX - 22, y: sealCY - 10 },
    end: { x: sealCX + 22, y: sealCY - 10 },
    thickness: 0.6,
    color: amber,
  });
  drawCentred(currentPage, "SECURE ESCROW", {
    cx: sealCX,
    y: sealCY - 21,
    size: 6,
    font: bold,
    color: rgb(0.7, 0.78, 0.9),
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ── FOOTER (last page) ─────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════
  drawPageFooter(currentPage);

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
