import express from "express";
import helmet from "helmet";
import dotenv from "dotenv";
dotenv.config();
import db from "../controllers/db.js";
import userRegisteration from "../routes/register.js";
import userLogin from "../routes/login.js";
import passwordReset from "../routes/passwordReset.js";
import userInvoices from "../routes/invoices.js";
import cors from "cors";
import cookieParser from "cookie-parser";
import requestPayments from "../routes/requestPayment.js";
import paymentWebhook from "../routes/paymentWebhook.js";
import releaseFunds from "../routes/payout.js";
import chat from "../routes/chat.js";
import dispute from "../routes/dispute.js";
import transactions from "../routes/transactions.js";
import profile from "../routes/profile.js";
import templates from "../routes/templates.js";
import referral from "../routes/referral.js";
import admin from "../routes/admin.js";
import notifications from "../routes/notifications.js";
import user from "../routes/user.js";
import aiChat from "../routes/aiChat.js";
import uploads from "../routes/uploads.js";
import { startScheduledJobs } from "../jobs/scheduledJobs.js";
import { fileURLToPath } from "url";
import path from "path";
import logger from "../utils/logger.js";
import { sanitizeBody } from "../middleware/sanitize.js";
import {
  maintenanceGuard,
  paymentsGuard,
  payoutsGuard,
} from "../middleware/platformGuard.js";
import {
  generalLimiter,
  loginLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  paymentByIpLimiter,
  paymentByInvoiceLimiter,
  invoiceCreateLimiter,
  actionLimiter,
  adminLoginLimiter,
  adminApiLimiter,
} from "../middleware/rateLimiters.js";

// ── Crash safety: log and survive unhandled errors ───────────────────────────
process.on("uncaughtException", (err) => {
  logger.error("Uncaught Exception — process will continue", {
    error: err.message,
    stack: err.stack,
  });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled Promise Rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

// ok
// Needed to serve uploaded files as static assets
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ── CORS — MUST be registered first, before helmet and everything else. ──────
// Browsers send an OPTIONS preflight before every cross-origin request.
// If any middleware runs before CORS and modifies/rejects the response,
// the browser sees no Access-Control-Allow-Origin header and aborts.

// Support a comma-separated FRONTEND_URL for multiple allowed origins.
// e.g. FRONTEND_URL=https://fonlok.vercel.app,https://fonlok.com,https://www.fonlok.com
const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, "")); // strip trailing slashes

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, mobile apps, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
};
app.use(cors(corsOptions));
// Handle all OPTIONS preflight requests immediately — no further middleware needed.
app.options(/(.*)/, cors(corsOptions));

// ── Security headers (helmet) ───────────────────────────────────────────────
// Registered AFTER cors() so helmet's Cross-Origin-* headers don't
// interfere with the CORS headers cors() already attached.
//   • X-Frame-Options: SAMEORIGIN          → blocks clickjacking
//   • X-Content-Type-Options: nosniff      → blocks MIME-sniffing
//   • Strict-Transport-Security            → enforces HTTPS (prod)
//   • X-XSS-Protection: 0                  → disables old broken XSS filter
//   • Referrer-Policy: no-referrer-when-downgrade
//   • Removes X-Powered-By: Express        → hides stack fingerprint
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },

    // Content-Security-Policy — restrictive policy appropriate for a JSON API.
    // Most directives are 'none' because this server never loads external
    // scripts, styles, or media. The HTML confirmation pages in payout.js are
    // self-contained inline HTML that need no external resources.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'none'"], // no JavaScript execution
        styleSrc: ["'unsafe-inline'"], // inline styles in HTML confirm pages
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"], // stronger than X-Frame-Options in modern browsers
        formAction: ["'self'"],
        baseUri: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },

    // HSTS must be disabled on the Node server itself — it belongs on the
    // TLS-terminating reverse proxy (nginx/Caddy). If Node sends HSTS,
    // browsers permanently cache it and break plain HTTP local dev.
    strictTransportSecurity: false,
  }),
);

// ── HTTPS enforcement (production only) ──────────────────────────────────────
// When sitting behind a TLS-terminating reverse proxy (nginx / Caddy),
// the proxy forwards the original protocol in X-Forwarded-Proto.
// NOTE: OPTIONS (preflight) requests are never redirected — browsers reject
// redirected preflights, which breaks CORS for every cross-origin API call.
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1); // trust first proxy (nginx/Caddy)
  app.use((req, res, next) => {
    // Let preflight pass through — CORS middleware already handled it above.
    if (req.method === "OPTIONS") return next();
    // Only redirect when actually behind a proxy (header present but not https).
    // Without a proxy (local dev with NODE_ENV=production), skip to avoid
    // ERR_SSL_PROTOCOL_ERROR on plain HTTP connections.
    const proto = req.headers["x-forwarded-proto"];
    if (proto && proto !== "https") {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

// ── HTTP request logger ───────────────────────────────────────────────────────
app.use((req, _res, next) => {
  logger.info("incoming request", {
    method: req.method,
    path: req.path,
    ip: req.ip,
  });
  next();
});

// ── Body parsing with size limits (DoS protection) ───────────────────────────
// 100 KB covers the largest legitimate payload (invoice with many milestones).
// Anything larger is almost certainly an attack or a programming error.
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));
app.use(cookieParser());

// ── Input sanitization — strip XSS from all body strings ─────────────────────
app.use(sanitizeBody);

// ── Rate limiting ────────────────────────────────────────────────────────────
// General limiter covers every route (catch-all for bots/scrapers).
app.use(generalLimiter);

// Specific tight limiters on high-risk routes.
app.post("/auth/login", loginLimiter);
app.post("/auth/register", registerLimiter);
app.post("/auth/forgot-password", forgotPasswordLimiter);
app.post("/auth/reset-password", resetPasswordLimiter);
app.post("/api/requestPayment", paymentByIpLimiter, paymentByInvoiceLimiter, paymentsGuard);
app.post("/invoice/create", invoiceCreateLimiter);
app.post("/dispute/open/:invoice_number", actionLimiter);
app.post("/api/release-funds", actionLimiter, payoutsGuard);
app.get("/api/release-milestone/:token", actionLimiter, payoutsGuard);
app.patch("/invoice/milestone/:milestone_id/complete", actionLimiter);
app.post("/invoice/resend-email/:invoice_number", actionLimiter);

// ── Admin rate limiting ───────────────────────────────────────────────────────
// Tighter limit on the login endpoint to block credential brute-force.
app.post("/admin/login", adminLoginLimiter);
// All other /admin/* routes get a moderate cap to prevent data exfiltration.
app.use("/admin", adminApiLimiter);
// ────────────────────────────────────────────────────────────────────────────

// ── Maintenance mode guard ────────────────────────────────────────────────────
// Blocks all non-admin traffic with HTTP 503 when maintenance_mode is enabled.
// Admin routes are exempted so the dashboard stays accessible during maintenance.
app.use((req, res, next) => {
  if (req.path.startsWith("/admin")) return next();
  maintenanceGuard(req, res, next);
});
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 5000;

app.use("/auth", userRegisteration);
app.use("/auth", userLogin);
app.use("/auth", passwordReset);
app.use("/invoice", userInvoices);
app.use("/api", requestPayments);
app.use("/payment", paymentWebhook);
app.use("/api", releaseFunds);
app.use("/chat", chat);
app.use("/dispute", dispute);
app.use("/transactions", transactions);
app.use("/profile", profile);
app.use("/templates", templates);
app.use("/referral", referral);
app.use("/admin", admin);
app.use("/notifications", notifications);
app.use("/user", user);
app.use("/api", aiChat);

// Serve uploaded files — authenticated only (prevents unauthenticated enumeration)
app.use("/uploads", uploads);

// ── Redirect alias: legacy /api/invoice/receipt/:id links (e.g. from old emails) ──
app.get("/api/invoice/receipt/:invoice_number", (req, res) => {
  res.redirect(301, `/invoice/receipt/${req.params.invoice_number}`);
});

// ── Global error handler ─────────────────────────────────────────────────────
// Must be registered LAST — after all routes.
// Catches any error passed via next(err) or thrown inside async routes that
// use express-async-errors or a try/catch with next(err).
// Without this, Express falls back to its default HTML error page which leaks
// stack traces (file paths, package versions, SQL queries) to the client.
app.use((err, req, res, _next) => {
  logger.error("Unhandled route error", {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });
  res.status(err.status || 500).json({
    error:
      process.env.NODE_ENV === "production"
        ? "Something went wrong. Please try again."
        : err.message,
  });
});

app.listen(PORT, async () => {
  logger.info(`Server is running on PORT ${PORT}`, {
    port: PORT,
    env: process.env.NODE_ENV || "development",
  });

  // Add created_at to guests table if missing — required by receipt generation
  // and scheduled jobs that ORDER BY created_at. Safe to run on every boot.
  try {
    await db.query(`
      ALTER TABLE guests
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);
    // Backfill any rows that got NULL due to a race before DEFAULT took effect
    await db.query(`
      UPDATE guests SET created_at = NOW() WHERE created_at IS NULL
    `);
  } catch (err) {
    logger.warn("guests.created_at migration failed", { error: err.message });
  }

  // One-time fix: strip the leading "uploads/" or "uploads\\" path prefix that
  // the old register route accidentally stored in profilepicture.
  // Safe to run on every boot — only affects rows that still have the bad prefix.
  try {
    const result = await db.query(`
      UPDATE users
      SET profilepicture = regexp_replace(profilepicture, '^uploads[\\/\\\\]', '')
      WHERE profilepicture ~ '^uploads[\\/\\\\]'
    `);
    if (result.rowCount > 0) {
      logger.info(`Fixed profilepicture paths for ${result.rowCount} user(s)`);
    }
  } catch (err) {
    logger.warn("profilepicture path migration failed", { error: err.message });
  }

  // Create admin_broadcasts table used by admin messaging feature.
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS admin_broadcasts (
        id               SERIAL PRIMARY KEY,
        recipient_type   VARCHAR(10)  NOT NULL,
        recipient_user_id INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        recipient_email  TEXT,
        subject          TEXT         NOT NULL,
        body             TEXT         NOT NULL,
        recipients_count INTEGER      NOT NULL DEFAULT 0,
        sent_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    logger.info("admin_broadcasts table ready");
  } catch (err) {
    logger.warn("admin_broadcasts migration failed", { error: err.message });
  }

  // Add a UNIQUE constraint on referral_earnings(invoice_number) so that the
  // ON CONFLICT (invoice_number) DO NOTHING clause in the payout routes never
  // double-credits a referrer for the same invoice, even under concurrent load.
  try {
    await db.query(`
      ALTER TABLE referral_earnings
        ADD CONSTRAINT referral_earnings_invoice_number_unique UNIQUE (invoice_number)
    `);
    logger.info("referral_earnings unique index added");
  } catch (err) {
    // 42P07 = duplicate_table / duplicate_object — constraint already exists, safe to ignore
    if (err.code !== "42P07" && !err.message.includes("already exists")) {
      logger.warn("referral_earnings unique index migration failed", {
        error: err.message,
      });
    }
  }

  // Add payout_reference columns so every payouts row is traceable back to
  // the originating invoice — essential for audit trails and dispute resolution.
  try {
    await db.query(
      "ALTER TABLE payouts ADD COLUMN IF NOT EXISTS invoice_id INTEGER REFERENCES invoices(id)",
    );
    await db.query(
      "ALTER TABLE payouts ADD COLUMN IF NOT EXISTS invoice_number TEXT",
    );
    logger.info("payouts.invoice_id / invoice_number columns ready");
  } catch (err) {
    logger.warn("payout_reference migration failed", { error: err.message });
  }

  // Create processed_payments table for atomic webhook idempotency.
  // The PRIMARY KEY on payment_uuid ensures only one INSERT per UUID can
  // ever succeed, eliminating the TOCTOU race in concurrent webhook retries.
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS processed_payments (
        payment_uuid  TEXT        PRIMARY KEY,
        processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    logger.info("processed_payments table ready");
  } catch (err) {
    logger.warn("processed_payments migration failed", { error: err.message });
  }

  await startScheduledJobs();

  // Create platform_settings table for maintenance mode and payment/payout toggles.
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        key        VARCHAR(100)  PRIMARY KEY,
        value      TEXT          NOT NULL DEFAULT 'false',
        updated_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `);
    logger.info("platform_settings table ready");
  } catch (err) {
    logger.warn("platform_settings migration failed", { error: err.message });
  }

  // Create balance_adjustments audit log (manual admin credit/debit).
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS balance_adjustments (
        id          SERIAL        PRIMARY KEY,
        admin_email VARCHAR(255)  NOT NULL,
        user_id     INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount      NUMERIC(12,2) NOT NULL,
        type        VARCHAR(10)   NOT NULL CHECK (type IN ('credit', 'debit')),
        reason      TEXT          NOT NULL,
        created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `);
    logger.info("balance_adjustments table ready");
  } catch (err) {
    logger.warn("balance_adjustments migration failed", { error: err.message });
  }

  // Add wallet_balance column to users (admin-credited funds for MoMo failure refunds).
  try {
    await db.query(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC(12,2) NOT NULL DEFAULT 0",
    );
    logger.info("users.wallet_balance column ready");
  } catch (err) {
    logger.warn("users.wallet_balance migration failed", { error: err.message });
  }
});
