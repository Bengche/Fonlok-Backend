/**
 * fix_payout_routing.mjs
 *
 * Patches payout.js so that API-created invoices (e.g. Njimbong)
 * route the MoMo payout and seller emails to the third-party seller
 * specified on the invoice (seller_phone / seller_email / seller_name)
 * instead of to Njimbong's own Fonlok account.
 *
 * Run once:  node fix_payout_routing.mjs
 * Delete this file after running.
 */

import { readFileSync, writeFileSync } from "fs";

const FILE = new URL(
  "./src/routes/payout.js",
  import.meta.url,
).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let src = readFileSync(FILE, "utf8");

// Detect line-ending style
const CRLF = src.includes("\r\n");
const NL = CRLF ? "\r\n" : "\n";

function nl(s) {
  // Normalise all \n in template strings to the file's native line endings
  return CRLF ? s.replace(/\n/g, "\r\n") : s;
}

// ─── Helper: assert exactly one match, then replace ────────────────────────
function patch(description, searchStr, replaceStr) {
  const count = src.split(searchStr).length - 1;
  if (count === 0) {
    console.error(`❌  NOT FOUND: ${description}`);
    return;
  }
  if (count > 1) {
    console.error(`❌  MULTIPLE MATCHES (${count}): ${description}`);
    return;
  }
  src = src.replace(searchStr, replaceStr);
  console.log(`✅  ${description}`);
}

// ─── Resolver block to inject after each invoiceUser declaration ─────────────
const RESOLVER = nl(`

  // ── Effective payout details ──────────────────────────────────────────────
  // For API-created invoices (e.g. Njimbong) money and emails must go to the
  // third-party seller specified on the invoice, NOT to Njimbong's own Fonlok
  // account (invoiceUser). For native invoices invoiceUser IS the seller.
  const isApiInvoice = !!(invoiceRow.created_via_api && invoiceRow.seller_phone);
  const payoutPhone = isApiInvoice ? invoiceRow.seller_phone : invoiceUser.phone;
  const payoutEmail = isApiInvoice ? (invoiceRow.seller_email || null) : invoiceUser.email;
  const payoutName  = isApiInvoice ? (invoiceRow.seller_name  || invoiceUser.name) : invoiceUser.name;`);

// ─── 1. executePayout — add resolver vars ────────────────────────────────────
// Unique anchor: "rows.length === 0" (executePayoutLink uses "!rows[0]")
patch(
  "executePayout: add resolver vars",
  nl(`  if (invoiceRes.rows.length === 0) throw new Error("Invoice not found");
  const invoiceRow = invoiceRes.rows[0];
  const sellerId = invoiceRow.userid;
  const grossAmount = Number(invoiceRow.amount);

  const userResult = await db.query("SELECT * FROM users WHERE id = $1", [
    sellerId,
  ]);
  if (userResult.rows.length === 0) throw new Error("Seller account not found");
  const invoiceUser = userResult.rows[0];`),
  nl(`  if (invoiceRes.rows.length === 0) throw new Error("Invoice not found");
  const invoiceRow = invoiceRes.rows[0];
  const sellerId = invoiceRow.userid;
  const grossAmount = Number(invoiceRow.amount);

  const userResult = await db.query("SELECT * FROM users WHERE id = $1", [
    sellerId,
  ]);
  if (userResult.rows.length === 0) throw new Error("Seller account not found");
  const invoiceUser = userResult.rows[0];`) + RESOLVER,
);

// ─── 2. executePayoutLink — add resolver vars ────────────────────────────────
// Unique anchor: "!invoiceRes.rows[0]"
patch(
  "executePayoutLink: add resolver vars",
  nl(`  if (!invoiceRes.rows[0]) throw new Error("Invoice not found");
  const invoiceRow = invoiceRes.rows[0];
  const sellerId = invoiceRow.userid;
  const grossAmount = Number(invoiceRow.amount);

  const userResult = await db.query("SELECT * FROM users WHERE id = $1", [
    sellerId,
  ]);
  if (userResult.rows.length === 0) throw new Error("Seller account not found");
  const invoiceUser = userResult.rows[0];`),
  nl(`  if (!invoiceRes.rows[0]) throw new Error("Invoice not found");
  const invoiceRow = invoiceRes.rows[0];
  const sellerId = invoiceRow.userid;
  const grossAmount = Number(invoiceRow.amount);

  const userResult = await db.query("SELECT * FROM users WHERE id = $1", [
    sellerId,
  ]);
  if (userResult.rows.length === 0) throw new Error("Seller account not found");
  const invoiceUser = userResult.rows[0];`) + RESOLVER,
);

// ─── 3. executePayout — fix Campay withdraw destination ──────────────────────
// Unique anchor: campayAuthLegacy1
patch(
  "executePayout: fix Campay withdraw to",
  nl(`      to: invoiceUser.phone,
      description: \`Fonlok payout for invoice \${invoiceRow.invoicenumber}\`,
      external_reference: invoiceRow.invoicenumber,
    },
    { headers: { Authorization: \`Token \${campayAuthLegacy1.data.token}\` } },`),
  nl(`      to: payoutPhone,
      description: \`Fonlok payout for invoice \${invoiceRow.invoicenumber}\`,
      external_reference: invoiceRow.invoicenumber,
    },
    { headers: { Authorization: \`Token \${campayAuthLegacy1.data.token}\` } },`),
);

// ─── 4. executePayoutLink — fix Campay withdraw destination ──────────────────
// Unique anchor: campayAuthLegacy2
patch(
  "executePayoutLink: fix Campay withdraw to",
  nl(`      to: invoiceUser.phone,
      description: \`Fonlok payout for invoice \${invoiceRow.invoicenumber}\`,
      external_reference: invoiceRow.invoicenumber,
    },
    { headers: { Authorization: \`Token \${campayAuthLegacy2.data.token}\` } },`),
  nl(`      to: payoutPhone,
      description: \`Fonlok payout for invoice \${invoiceRow.invoicenumber}\`,
      external_reference: invoiceRow.invoicenumber,
    },
    { headers: { Authorization: \`Token \${campayAuthLegacy2.data.token}\` } },`),
);

// ─── 5. executePayout — wrap notifyUser in if (!isApiInvoice) ─────────────────
// Unique anchor: "Mark the invoice as completed so any subsequent" comment
patch(
  "executePayout: wrap notifyUser",
  nl(`  notifyUser(
    sellerId,
    "payout_sent",
    "Payout Sent",
    \`\${sellerReceives} XAF has been sent to your Mobile Money account for invoice \${invoiceRow.invoicenumber}.\`,
    { amount: sellerReceives, invoiceNumber: invoiceRow.invoicenumber },
  );

  // ── Step 7: Credit referral earnings — INSERT first, balance only if new ──
  // The earnings row is the single source of truth.  INSERT with RETURNING`),
  nl(`  // Skip in-app/push notification for API invoices — the actual seller is a
  // third party, not the Fonlok account holder (Njimbong).
  if (!isApiInvoice) {
    notifyUser(
      sellerId,
      "payout_sent",
      "Payout Sent",
      \`\${sellerReceives} XAF has been sent to your Mobile Money account for invoice \${invoiceRow.invoicenumber}.\`,
      { amount: sellerReceives, invoiceNumber: invoiceRow.invoicenumber },
    );
  }

  // ── Step 7: Credit referral earnings — INSERT first, balance only if new ──
  // The earnings row is the single source of truth.  INSERT with RETURNING`),
);

// ─── 6. executePayoutLink — wrap notifyUser in if (!isApiInvoice) ─────────────
// Unique anchor: executePayoutLink Step 7 does NOT have the long comment above Step 7
patch(
  "executePayoutLink: wrap notifyUser",
  nl(`  notifyUser(
    sellerId,
    "payout_sent",
    "Payout Sent",
    \`\${sellerReceives} XAF has been sent to your Mobile Money account for invoice \${invoiceRow.invoicenumber}.\`,
    { amount: sellerReceives, invoiceNumber: invoiceRow.invoicenumber },
  );

  // ── Step 7: Credit referral earnings — INSERT first, balance only if new ──
  if (hasReferral && referralEarning > 0) {`),
  nl(`  // Skip in-app/push notification for API invoices — the actual seller is a
  // third party, not the Fonlok account holder (Njimbong).
  if (!isApiInvoice) {
    notifyUser(
      sellerId,
      "payout_sent",
      "Payout Sent",
      \`\${sellerReceives} XAF has been sent to your Mobile Money account for invoice \${invoiceRow.invoicenumber}.\`,
      { amount: sellerReceives, invoiceNumber: invoiceRow.invoicenumber },
    );
  }

  // ── Step 7: Credit referral earnings — INSERT first, balance only if new ──
  if (hasReferral && referralEarning > 0) {`),
);

// ─── 7. Both functions — fix seller receipt email "to" field ──────────────────
// Replace all occurrences (there are exactly 2, one per function)
const OLD_EMAIL_TO = nl(`    to: invoiceUser.email,
    from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
    subject: payoutCopy.subject(invoiceRow.invoicenumber),`);
const NEW_EMAIL_TO = nl(`    to: payoutEmail,
    from: { email: process.env.VERIFIED_SENDER, name: "Fonlok" },
    subject: payoutCopy.subject(invoiceRow.invoicenumber),`);
const emailToCount = src.split(OLD_EMAIL_TO).length - 1;
console.log(`sellerReceiptMsg.to occurrences: ${emailToCount} (expected 2)`);
src = src.replaceAll(OLD_EMAIL_TO, NEW_EMAIL_TO);

// ─── 8. Both functions — fix payoutCopy.body (seller name) ──────────────────
const OLD_BODY = "`${payoutCopy.body(invoiceUser.name)}`";
const NEW_BODY = "`${payoutCopy.body(payoutName)}`";
const bodyCount = src.split(OLD_BODY).length - 1;
console.log(`payoutCopy.body occurrences: ${bodyCount} (expected 2)`);
src = src.replaceAll(OLD_BODY, NEW_BODY);

// ─── 9. Both functions — fix sentTo phone in email table ─────────────────────
const OLD_SENT = "[payoutCopy.sentTo, invoiceUser.phone]";
const NEW_SENT = "[payoutCopy.sentTo, payoutPhone]";
const sentCount = src.split(OLD_SENT).length - 1;
console.log(`payoutCopy.sentTo occurrences: ${sentCount} (expected 2)`);
src = src.replaceAll(OLD_SENT, NEW_SENT);

// ─── Write patched file ───────────────────────────────────────────────────────
writeFileSync(FILE, src);
console.log("\n✅  payout.js patched successfully.");
