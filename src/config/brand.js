/**
 * BRAND CONFIGURATION — Single point of truth
 *
 * Every piece of brand identity lives here.
 * To rebrand or update contact details, edit ONLY this file.
 * Import from this file anywhere in the backend.
 *
 * Usage:
 *   import { BRAND } from "../config/brand.js";
 *   sgMail.send({ from: BRAND.supportEmail, ... });
 */

// Derive the live frontend URL from the environment, falling back to the
// production URL so that emails sent in non-local environments are never wrong.
const _siteUrl = (process.env.FRONTEND_URL || "https://fonlok.com").replace(/\/$/, "");
const _domain = _siteUrl.replace(/^https?:\/\/(?:www\.)?/, "");

export const BRAND = {
  // The product name used in emails, logs, and API responses
  name: "Fonlok",

  // Full tagline
  tagline: "Secure escrow payments for Cameroon",

  // The root domain (no trailing slash) — derived from FRONTEND_URL
  domain: _domain,

  // Primary website URL — driven by FRONTEND_URL env var
  siteUrl: _siteUrl,

  // Support / contact email — used as the sender in all outgoing emails
  supportEmail: "support@fonlok.com",

  // WhatsApp and phone support — same number
  supportPhone: "+237654155218",
  whatsappUrl: "https://wa.me/237654155218",

  // Grouped contact object for convenience
  contact: {
    email: "support@fonlok.com",
    phone: "+237654155218",
    whatsapp: "https://wa.me/237654155218",
  },
};
