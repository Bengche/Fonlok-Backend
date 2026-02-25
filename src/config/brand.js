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

export const BRAND = {
  // The product name used in emails, logs, and API responses
  name: "Fonlok",

  // Full tagline
  tagline: "Secure escrow payments for Cameroon",

  // The root domain (no trailing slash)
  domain: "fonlok.com",

  // Primary website URL
  siteUrl: "https://fonlok.com",

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
