/**
 * fix_payout_routing2.mjs  — fixes remaining 3 issues after first script
 * Run once: node fix_payout_routing2.mjs
 */
import { readFileSync, writeFileSync } from "fs";

const FILE = new URL(
  "./src/routes/payout.js",
  import.meta.url,
).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let src = readFileSync(FILE, "utf8");

const CRLF = src.includes("\r\n");
const NL = CRLF ? "\r\n" : "\n";
function nl(s) {
  return CRLF ? s.replace(/\n/g, "\r\n") : s;
}

// ─── 1 & 2. Wrap BOTH notifyUser calls in if (!isApiInvoice) ─────────────────
// Both functions have identical notifyUser blocks — replace both at once.
const notifyOld = nl(
  `  notifyUser(
    sellerId,
    "payout_sent",
    "Payout Sent",
    \`\${sellerReceives} XAF has been sent to your Mobile Money account for invoice \${invoiceRow.invoicenumber}.\`,
    { amount: sellerReceives, invoiceNumber: invoiceRow.invoicenumber },
  );`,
);
const notifyNew = nl(
  `  // Skip for API invoices: the actual seller is a third party (not Njimbong).
  if (!isApiInvoice) {
    notifyUser(
      sellerId,
      "payout_sent",
      "Payout Sent",
      \`\${sellerReceives} XAF has been sent to your Mobile Money account for invoice \${invoiceRow.invoicenumber}.\`,
      { amount: sellerReceives, invoiceNumber: invoiceRow.invoicenumber },
    );
  }`,
);
const notifyCount = src.split(notifyOld).length - 1;
console.log(`notifyUser occurrences to wrap: ${notifyCount} (expected 2)`);
src = src.replaceAll(notifyOld, notifyNew);

// ─── 3. Fix payoutCopy.body(invoiceUser.name) in email template ───────────────
// The text appears inside a template literal, no outer backticks needed.
const bodyOld = "${payoutCopy.body(invoiceUser.name)}";
const bodyNew = "${payoutCopy.body(payoutName)}";
const bodyCount = src.split(bodyOld).length - 1;
console.log(`payoutCopy.body occurrences: ${bodyCount} (expected 2)`);
src = src.replaceAll(bodyOld, bodyNew);

writeFileSync(FILE, src);
console.log("\n✅  payout.js patched (round 2).");
