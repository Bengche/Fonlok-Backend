/**
 * Fonlok shared email template utilities.
 * All branded transactional emails should use these helpers so they
 * look consistent with the invoice-reminder "gold standard" template.
 */

// ── Fonlok brand logo — inline SVG encoded as base64 for email clients ──────
export const LOGO_B64 = Buffer.from(
  '<svg width="40" height="40" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<rect width="48" height="48" rx="11" fill="#0F1F3D"/>' +
    '<rect x="12.5" y="10" width="22.5" height="7.5" rx="3.75" fill="#F59E0B"/>' +
    '<rect x="12.5" y="21.5" width="15" height="5.5" rx="2.75" fill="#FFFFFF"/>' +
    '<rect x="12.5" y="10" width="6.5" height="27.5" rx="3" fill="#FFFFFF"/>' +
    "</svg>",
).toString("base64");

/**
 * Branded email header — navy bar with logo, wordmark and optional subtitle.
 * @param {string} [subtitle="Secure Escrow Payments"]
 */
export function emailHeader(subtitle = "Secure Escrow Payments") {
  return `<div style="background:#0F1F3D;padding:18px 24px;line-height:1;">
      <span style="display:inline-block;width:34px;height:34px;background:#F59E0B;border-radius:8px;text-align:center;line-height:34px;font-size:19px;font-weight:900;color:#0F1F3D;vertical-align:middle;margin-right:10px;font-family:Arial,sans-serif;">F</span>
      <span style="font-size:20px;font-weight:800;letter-spacing:-0.5px;vertical-align:middle;">
        <span style="color:#F59E0B;">F</span><span style="color:#ffffff;">onlok</span>
      </span>
      <span style="color:#94a3b8;font-size:12px;margin-left:12px;vertical-align:middle;">${subtitle}</span>
    </div>`;
}

/**
 * Footer note that sits below a top-border inside the body panel.
 * @param {string} [note]
 */
export function emailFooter(
  note = "You received this email because of activity on your Fonlok account.",
) {
  return `<p style="color:#94a3b8;font-size:12px;border-top:1px solid #e2e8f0;padding-top:16px;margin-top:24px;line-height:1.6;">${note}</p>`;
}

/**
 * Full email wrapper — header + white body panel + footer.
 * @param {string}  bodyHtml  HTML to place inside the body panel (before footer).
 * @param {object}  [opts]
 * @param {string}  [opts.subtitle]   Tagline shown in the header (default "Secure Escrow Payments").
 * @param {string}  [opts.footerNote] Text shown in the footer panel.
 */
export function emailWrap(bodyHtml, { subtitle, footerNote } = {}) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body style="margin:0;padding:0;background:#f8fafc;">
  <div style="font-family:sans-serif;max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
    ${emailHeader(subtitle)}
    <div style="padding:24px;">
      ${bodyHtml}
      ${emailFooter(footerNote)}
    </div>
  </div></body></html>`;
}

/**
 * Striped info table.
 * @param {Array<[string, string, string?]>} rows  Each entry is [label, value, extraValueStyle?].
 *   Supply e.g. "font-weight:700;color:#16a34a;font-size:15px;" as the third element to
 *   highlight a value (useful for amounts).
 */
export function emailTable(rows) {
  return `<table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f8fafc;border-radius:6px;">
    ${rows
      .map(
        ([label, value, valStyle = ""], i) =>
          `<tr${i % 2 === 1 ? ' style="background:#f1f5f9;"' : ""}>
        <td style="padding:10px 14px;font-weight:600;color:#64748b;font-size:13px;">${label}</td>
        <td style="padding:10px 14px;color:#0f172a;${valStyle}">${value}</td>
      </tr>`,
      )
      .join("")}
  </table>`;
}

/**
 * Amber primary CTA button (standard Fonlok action).
 */
export function emailButton(href, label) {
  return `<a href="${href}" style="display:inline-block;background:#F59E0B;color:#0F1F3D;padding:13px 28px;text-decoration:none;border-radius:7px;font-weight:700;font-size:15px;margin:8px 0 20px;">${label} →</a>`;
}

/**
 * Navy secondary CTA button.
 */
export function emailButtonNavy(href, label) {
  return `<a href="${href}" style="display:inline-block;background:#0F1F3D;color:#F59E0B;padding:13px 28px;text-decoration:none;border-radius:7px;font-weight:700;font-size:15px;margin:8px 0 20px;">${label} →</a>`;
}

/**
 * Red danger CTA button (disputes, warnings).
 */
export function emailButtonDanger(href, label) {
  return `<a href="${href}" style="display:inline-block;background:#dc2626;color:#ffffff;padding:13px 28px;text-decoration:none;border-radius:7px;font-weight:700;font-size:15px;margin:8px 0 20px;">${label} →</a>`;
}
