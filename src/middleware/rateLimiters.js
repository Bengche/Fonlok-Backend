/**
 * rateLimiters.js
 *
 * Targeted rate limiting for Fonlok's fintech routes.
 *
 * DESIGN PRINCIPLE
 * ─────────────────
 * Different endpoints have very different risk profiles. A single global
 * limiter would either be too tight (blocking real users on busy routes)
 * or too loose (leaving attack-prone routes unprotected). Each limiter
 * below is tuned specifically to its threat model.
 *
 * All limits are per IP address. Where the threat is invoice-specific
 * (e.g. someone spamming a single victim's phone from many IPs) a second
 * per-resource limiter is also applied.
 */

import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import jwt from "jsonwebtoken";

// ─── Helper: consistent JSON error shape ────────────────────────────────────
const jsonMessage = (msg) => ({
  type: "rate_limit",
  message: msg,
});

// ─── Helper: per-user key for authenticated routes ───────────────────────────
// In Cameroon, MTN and Orange mobile internet use CGNAT — many users share
// the same public IP. If we key every limiter on IP alone, one user's requests
// can exhaust another user's quota. For any route where the user is logged in,
// we decode the JWT (without verifying — auth middleware does that separately)
// to extract their user ID and use that as the rate-limit key instead.
// Unauthenticated requests (no token / bad token) fall back to IP as before.
const userOrIpKey = (req) => {
  try {
    const header = req.headers.authorization;
    const cookie = req.cookies?.authToken;
    const raw = header?.startsWith("Bearer ") ? header.slice(7) : cookie;
    if (raw && raw !== "undefined" && raw !== "null") {
      const decoded = jwt.decode(raw); // decode only — no signature check needed here
      if (decoded?.id) return `user:${decoded.id}`;
    }
  } catch {
    // ignore — fall through to IP
  }
  return ipKeyGenerator(req);
};

// ─── 1. LOGIN — brute-force protection ──────────────────────────────────────
// Threat: attacker cycling passwords against a known email.
// 10 attempts per 15 min per IP is generous for a legitimate user who
// mis-types their password — but painful for a brute-force script.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage(
    "Too many sign-in attempts from this device. Please wait 15 minutes before trying again.",
  ),
  skipSuccessfulRequests: true, // Only *failed* logins count toward the limit
});

// ─── 2. REGISTER — account-spam protection ──────────────────────────────────
// Threat: bots bulk-creating fake seller accounts.
// Must remain IP-keyed (no JWT available yet). Raised from 5→10 to account
// for CGNAT: multiple people in the same building / on the same ISP may all
// legitimately register within the same hour from the same public IP.
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage(
    "Too many accounts created from this device. Please try again in an hour.",
  ),
});

// ─── 3. FORGOT PASSWORD — email-bombing protection ──────────────────────────
// Threat: flooding a victim's inbox with reset emails, or enumerating
// which emails are registered.
// 5 per 30 min per IP. A forgetful user who hits this limit can wait
// 30 min — that is perfectly reasonable.
export const forgotPasswordLimiter = rateLimit({
  windowMs: 30 * 60 * 1000, // 30 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage(
    "Too many password reset requests. Please wait 30 minutes before requesting another link.",
  ),
});

// ─── 4. RESET PASSWORD — token guessing protection ──────────────────────────
// Threat: attacker brute-forcing the 64-character hex token (astronomically
// unlikely, but belt-and-suspenders). Also covers replay attempts.
// 8 per 15 min is fine for a legitimate user who hits Back and retries.
export const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage(
    "Too many password reset attempts. Please wait 15 minutes.",
  ),
});

// ─── 5. PAYMENT TRIGGER — MoMo prompt spam protection (per user / IP) ────────
// Threat #1: attacker using a victim's phone number to trigger endless MoMo
// prompts on their device (denial of service via phone).
// Threat #2: attacker testing stolen credentials at scale.
//
// Keyed on user ID when authenticated — prevents CGNAT from causing one
// legitimate buyer to exhaust another's payment quota.
// 8 attempts per 10 min per user is generous for genuine retries but
// still stops automated credential-stuffing / MoMo-spam scripts cold.
export const paymentByIpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: jsonMessage(
    "Too many payment attempts. Please wait a few minutes before trying again.",
  ),
});

// ─── 6. PAYMENT TRIGGER — per-invoice limiter ───────────────────────────────
// Threat: attacker rotating IPs to keep hammering the same invoice
// (still spamming the victim's phone even with IP limiting).
//
// Key = (user OR ip) + invoiceId — each user gets their own bucket per
// invoice. Two different users paying the same invoice from the same
// CGNAT IP no longer share a counter and cannot block each other.
export const paymentByInvoiceLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const identity = userOrIpKey(req); // user:123 or the raw IP
    const invoiceId = req.body?.invoiceid ?? "unknown";
    return `${identity}:invoice:${invoiceId}`;
  },
  message: jsonMessage(
    "This invoice has received too many payment attempts. Please wait 5 minutes.",
  ),
});

// ─── 7. INVOICE CREATION — spam / scraping protection ───────────────────────
// Threat: bots generating thousands of fake invoices to pollute the DB
// or enumerate system behaviour.
// Keyed on user ID — a power-seller creating 30 invoices/hr is fine;
// nobody else's quota is affected under CGNAT.
export const invoiceCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: jsonMessage(
    "You have created too many invoices in a short period. Please try again in an hour.",
  ),
});

// ─── 8. DISPUTE / PAYOUT / RELEASE — action spam protection ─────────────────
// Threat: someone spamming dispute submissions or payout requests.
// Keyed on user ID — a real user doing 20 dispute/payout actions in 15 min
// is their own limit; CGNAT users don't share it.
export const actionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: jsonMessage(
    "Too many requests. Please slow down and try again shortly.",
  ),
});

// ─── 9. GENERAL API — catch-all for everything else ─────────────────────────
// Threat: generic scraping, enumeration, DoS.
//
// Keyed on user ID when authenticated so CGNAT never causes one user's
// requests to consume another user's quota.
//
// 500 req/min per user gives enormous headroom:
//   – Dashboard load: ~8 concurrent calls
//   – Notifications poll: ~2/min
//   – Active power user: ~30–50/min
//   – 10× safety margin still = 500 → only scripts get blocked
//
// Unauthenticated IPs are still capped at 500/min (covers anonymous
// browsing and pre-login flows from even the busiest shared IP).
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: jsonMessage("Too many requests from this device. Please slow down."),
  skipSuccessfulRequests: false,
});

// ─── 10. ADMIN LOGIN — brute-force on admin credentials ──────────────────────
// Threat: attacker who has guessed/leaked the admin email now cycling passwords.
// 5 attempts per 15 min per IP. A real admin who forgets their password
// has 5 tries then waits 15 min — acceptable for a back-office login.
export const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage(
    "Too many admin login attempts. Please wait 15 minutes before trying again.",
  ),
  skipSuccessfulRequests: true,
});

// ─── 11. ADMIN API — protect every admin route ───────────────────────────────
// Threat: attacker with a leaked/stolen admin JWT making bulk operations
// (mass data export, bulk broadcasts, etc.).
// 120 per minute is plenty for a human using the dashboard;
// it stops scripted bulk-exfiltration cold.
export const adminApiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonMessage("Too many admin requests. Please slow down."),
});
