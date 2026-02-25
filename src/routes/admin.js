import express from "express";
const router = express.Router();
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import db from "../controllers/db.js";
import adminMiddleware from "../middleware/adminMiddleware.js";
import sgMail from "@sendgrid/mail";
import { emailWrap } from "../utils/emailTemplate.js";
import { BRAND } from "../config/brand.js";
dotenv.config();
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ─── Pagination helper ────────────────────────────────────────────────────────
// Parses ?page and ?limit from query string with safe defaults
const getPagination = (query) => {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 10));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/login  (public — no middleware)
// Verifies ADMIN_EMAIL and ADMIN_PASSWORD stored in .env
// Issues a short-lived JWT in a secure HTTP-only cookie
// ─────────────────────────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res
      .status(400)
      .json({ message: "Email and password are required." });
  }

  const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase().trim();
  const adminPassword = process.env.ADMIN_PASSWORD?.trim();

  if (email.toLowerCase().trim() !== adminEmail || password !== adminPassword) {
    return res.status(401).json({ message: "Invalid admin credentials." });
  }

  const token = jwt.sign(
    { isAdmin: true, email: adminEmail },
    process.env.JWT_SECRET,
    { expiresIn: "8h" },
  );

  res.cookie("adminToken", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  });

  console.log(`✅ Admin logged in: ${adminEmail}`);
  res.json({ message: "Logged in successfully." });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/logout
// ─────────────────────────────────────────────────────────────────────────────
router.post("/logout", (req, res) => {
  res.clearCookie("adminToken", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  });
  res.json({ message: "Logged out." });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/verify
// The frontend calls this on load to check whether the admin session is still valid
// ─────────────────────────────────────────────────────────────────────────────
router.get("/verify", adminMiddleware, (req, res) => {
  res.json({ isAdmin: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/stats
// Returns platform-wide overview numbers for the dashboard header cards
// ─────────────────────────────────────────────────────────────────────────────
router.get("/stats", adminMiddleware, async (req, res) => {
  try {
    const [
      usersResult,
      invoicesResult,
      paymentsResult,
      payoutsResult,
      openDisputesResult,
      resolvedDisputesResult,
      revenueResult,
      referralEarningsResult,
      referralUsersResult,
    ] = await Promise.all([
      // Total registered users
      db.query("SELECT COUNT(*) FROM users"),

      // Total invoices (all statuses)
      db.query("SELECT COUNT(*) FROM invoices"),

      // Total successful payments and amount processed
      db.query(
        "SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'paid'",
      ),

      // Total payouts made
      db.query(
        "SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM payouts WHERE status = 'paid'",
      ),

      // Open disputes
      db.query("SELECT COUNT(*) FROM disputes WHERE status = 'open'"),

      // Resolved disputes
      db.query("SELECT COUNT(*) FROM disputes WHERE status LIKE 'resolved%'"),

      // Platform revenue = 2% of all paid invoice amounts
      db.query(
        "SELECT COALESCE(SUM(amount * 0.02), 0) AS revenue FROM invoices WHERE status = 'paid'",
      ),

      // Total referral commissions ever earned by referrers
      db.query(
        "SELECT COALESCE(SUM(earned_amount), 0) AS total FROM referral_earnings",
      ),

      // Number of users who have ever referred at least one person
      db.query(
        "SELECT COUNT(DISTINCT referred_by) FROM users WHERE referred_by IS NOT NULL",
      ),
    ]);

    res.json({
      totalUsers: parseInt(usersResult.rows[0].count),
      totalInvoices: parseInt(invoicesResult.rows[0].count),

      totalPaymentsCount: parseInt(paymentsResult.rows[0].count),
      totalAmountProcessed: parseFloat(paymentsResult.rows[0].total),

      totalPayoutsCount: parseInt(payoutsResult.rows[0].count),
      totalPayoutsAmount: parseFloat(payoutsResult.rows[0].total),

      openDisputes: parseInt(openDisputesResult.rows[0].count),
      resolvedDisputes: parseInt(resolvedDisputesResult.rows[0].count),

      // Platform revenue = 2% of paid invoices, minus 0.5% paid out as referral fees
      platformRevenue: parseFloat(revenueResult.rows[0].revenue),
      totalReferralCommissionsPaid: parseFloat(
        referralEarningsResult.rows[0].total,
      ),

      activeReferrers: parseInt(referralUsersResult.rows[0].count),
    });
  } catch (err) {
    console.error("Admin stats error:", err);
    res.status(500).json({ message: "Failed to load stats." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/users?page=1&limit=10
// Paginated list of all registered users
// ─────────────────────────────────────────────────────────────────────────────
router.get("/users", adminMiddleware, async (req, res) => {
  const { page, limit, offset } = getPagination(req.query);

  try {
    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT
           u.id,
           u.name,
           u.username,
           u.email,
           u.phone,
           u.country,
           u.createdat,
           u.referral_code,
           u.referral_balance,
           COUNT(i.id) AS invoice_count
         FROM users u
         LEFT JOIN invoices i ON i.userid = u.id
         GROUP BY u.id
         ORDER BY u.createdat DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      db.query("SELECT COUNT(*) FROM users"),
    ]);

    const total = parseInt(countResult.rows[0].count);

    res.json({
      data: dataResult.rows,
      total,
      page,
      hasMore: offset + limit < total,
    });
  } catch (err) {
    console.error("Admin users error:", err);
    res.status(500).json({ message: "Failed to load users." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/invoices?page=1&limit=10
// Paginated list of all invoices with the seller's name
// ─────────────────────────────────────────────────────────────────────────────
router.get("/invoices", adminMiddleware, async (req, res) => {
  const { page, limit, offset } = getPagination(req.query);

  try {
    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT
           i.id,
           i.invoicenumber,
           i.invoicename,
           i.amount,
           i.currency,
           i.status,
           i.clientemail,
           i.description,
           i.createdat,
           i.expires_at,
           u.name  AS seller_name,
           u.email AS seller_email
         FROM invoices i
         JOIN users u ON u.id = i.userid
         ORDER BY i.createdat DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      db.query("SELECT COUNT(*) FROM invoices"),
    ]);

    const total = parseInt(countResult.rows[0].count);

    res.json({
      data: dataResult.rows,
      total,
      page,
      hasMore: offset + limit < total,
    });
  } catch (err) {
    console.error("Admin invoices error:", err);
    res.status(500).json({ message: "Failed to load invoices." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/payments?page=1&limit=10
// Paginated list of all buyer payments
// ─────────────────────────────────────────────────────────────────────────────
router.get("/payments", adminMiddleware, async (req, res) => {
  const { page, limit, offset } = getPagination(req.query);

  try {
    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT
           p.id,
           p.amount,
           p.status,
           p.method,
           p.createdat,
           p.providerpaymentid,
           i.invoicenumber,
           i.invoicename,
           i.currency,
           u.name  AS seller_name,
           u.email AS seller_email
         FROM payments p
         JOIN invoices i ON i.id = p.invoiceid
         JOIN users   u ON u.id = i.userid
         ORDER BY p.createdat DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      db.query("SELECT COUNT(*) FROM payments"),
    ]);

    const total = parseInt(countResult.rows[0].count);

    res.json({
      data: dataResult.rows,
      total,
      page,
      hasMore: offset + limit < total,
    });
  } catch (err) {
    console.error("Admin payments error:", err);
    res.status(500).json({ message: "Failed to load payments." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/payouts?page=1&limit=10
// Paginated list of all seller payouts
// ─────────────────────────────────────────────────────────────────────────────
router.get("/payouts", adminMiddleware, async (req, res) => {
  const { page, limit, offset } = getPagination(req.query);

  try {
    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT
           p.id,
           p.invoice_number,
           p.invoice_id,
           p.amount,
           p.method,
           p.status,
           p.createdat,
           u.name    AS seller_name,
           u.email   AS seller_email,
           u.phone   AS seller_phone
         FROM payouts p
         JOIN users u ON u.id = p.userid
         ORDER BY p.createdat DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      db.query("SELECT COUNT(*) FROM payouts"),
    ]);

    const total = parseInt(countResult.rows[0].count);

    res.json({
      data: dataResult.rows,
      total,
      page,
      hasMore: offset + limit < total,
    });
  } catch (err) {
    console.error("Admin payouts error:", err);
    res.status(500).json({ message: "Failed to load payouts." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/invoices/stuck?page=1&limit=10
// Invoices in 'paid' or 'delivered' status that are awaiting fund release.
// These are actionable — admin can see what is held up and contact parties.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/invoices/stuck", adminMiddleware, async (req, res) => {
  const { page, limit, offset } = getPagination(req.query);

  try {
    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT
           i.id,
           i.invoicenumber,
           i.invoicename,
           i.amount,
           i.currency,
           i.status,
           i.clientemail,
           i.createdat,
           i.delivered_at,
           u.name  AS seller_name,
           u.email AS seller_email,
           u.phone AS seller_phone,
           p.status AS payment_status,
           p.createdat AS paid_at
         FROM invoices i
         JOIN users u ON u.id = i.userid
         LEFT JOIN payments p ON p.invoiceid = i.id AND p.status = 'paid'
         WHERE i.status IN ('paid', 'delivered')
         ORDER BY i.createdat ASC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      db.query(
        "SELECT COUNT(*) FROM invoices WHERE status IN ('paid', 'delivered')",
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);

    res.json({
      data: dataResult.rows,
      total,
      page,
      hasMore: offset + limit < total,
    });
  } catch (err) {
    console.error("Admin stuck invoices error:", err);
    res.status(500).json({ message: "Failed to load stuck invoices." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/disputes?page=1&limit=10
// Paginated list of all disputes
// ─────────────────────────────────────────────────────────────────────────────
router.get("/disputes", adminMiddleware, async (req, res) => {
  const { page, limit, offset } = getPagination(req.query);

  try {
    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT
           d.id,
           d.invoicenumber,
           d.opened_by,
           d.reason,
           d.status,
           d.admin_token,
           d.created_at,
           i.invoicename,
           i.amount,
           i.currency,
           u.name  AS seller_name,
           u.email AS seller_email
         FROM disputes d
         JOIN invoices i ON i.invoicenumber = d.invoicenumber
         JOIN users   u ON u.id = i.userid
         ORDER BY d.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      db.query("SELECT COUNT(*) FROM disputes"),
    ]);

    const total = parseInt(countResult.rows[0].count);

    res.json({
      data: dataResult.rows,
      total,
      page,
      hasMore: offset + limit < total,
    });
  } catch (err) {
    console.error("Admin disputes error:", err);
    res.status(500).json({ message: "Failed to load disputes." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/referrals?page=1&limit=10
// Paginated list of users who have referred at least one person
// Shows: referral code, how many people they referred, total earned, current balance
// ─────────────────────────────────────────────────────────────────────────────
router.get("/referrals", adminMiddleware, async (req, res) => {
  const { page, limit, offset } = getPagination(req.query);

  try {
    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT
           u.id,
           u.name,
           u.username,
           u.email,
           u.referral_code,
           u.referral_balance,
           COUNT(DISTINCT ru.id)         AS referred_count,
           COALESCE(SUM(re.earned_amount), 0) AS total_earned
         FROM users u
         LEFT JOIN users            ru ON ru.referred_by = u.id
         LEFT JOIN referral_earnings re ON re.referrer_userid = u.id
         WHERE u.referral_code IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM users WHERE referred_by = u.id
           )
         GROUP BY u.id
         ORDER BY total_earned DESC, u.name ASC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      db.query(
        `SELECT COUNT(*) FROM users
         WHERE referral_code IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM users ru WHERE ru.referred_by = users.id
           )`,
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);

    res.json({
      data: dataResult.rows,
      total,
      page,
      hasMore: offset + limit < total,
    });
  } catch (err) {
    console.error("Admin referrals error:", err);
    res.status(500).json({ message: "Failed to load referral data." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/users/search?q=<term>
// Searches users by name, username, or email — used by the direct-message picker
// ─────────────────────────────────────────────────────────────────────────────
router.get("/users/search", adminMiddleware, async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.json({ data: [] });

  try {
    const result = await db.query(
      `SELECT id, name, username, email
       FROM users
       WHERE name ILIKE $1 OR username ILIKE $1 OR email ILIKE $1
       ORDER BY name ASC
       LIMIT 10`,
      [`%${q}%`],
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error("Admin user search error:", err);
    res.status(500).json({ message: "Search failed." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/broadcast
// Send a message to all users (broadcast) or to a single user (direct).
// Body: { recipientType: 'all'|'user', userId?: number, subject: string, body: string }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/broadcast", adminMiddleware, async (req, res) => {
  const { recipientType, userId, subject, body } = req.body;

  if (!subject?.trim() || !body?.trim()) {
    return res.status(400).json({ message: "Subject and body are required." });
  }
  if (!recipientType || !["all", "user"].includes(recipientType)) {
    return res
      .status(400)
      .json({ message: 'recipientType must be "all" or "user".' });
  }

  // Build HTML from the plain-text body (preserve line breaks)
  const bodyHtml = body
    .trim()
    .split(/\r?\n/)
    .map((line) =>
      line.trim()
        ? `<p style="margin:0 0 10px;color:#0f172a;font-size:15px;line-height:1.6;">${line}</p>`
        : `<p style="margin:0 0 10px;">&nbsp;</p>`,
    )
    .join("");

  try {
    if (recipientType === "all") {
      // ── Broadcast to all registered users ──────────────────────────────────
      const usersRes = await db.query(
        "SELECT id, name, email FROM users ORDER BY id",
      );
      const users = usersRes.rows;

      if (users.length === 0) {
        return res.status(400).json({ message: "No registered users found." });
      }

      // Build one message object per recipient
      const messages = users.map((u) => ({
        to: u.email,
        from: { name: BRAND.name, email: BRAND.supportEmail },
        subject: subject.trim(),
        html: emailWrap(
          `<p style="margin:0 0 16px;font-size:15px;color:#0f172a;">Hi <strong>${u.name}</strong>,</p>` +
            bodyHtml +
            `<p style="margin:16px 0 0;font-size:13px;color:#64748b;">— The ${BRAND.name} Team</p>`,
          { subtitle: "Message from Fonlok" },
        ),
      }));

      // sendMultiple delivers to each recipient individually
      const results = await Promise.allSettled(
        messages.map((msg) => sgMail.send(msg)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const sent = results.length - failed;

      // Store broadcast record
      await db.query(
        `INSERT INTO admin_broadcasts
           (recipient_type, subject, body, recipients_count)
         VALUES ($1, $2, $3, $4)`,
        ["all", subject.trim(), body.trim(), sent],
      );

      console.log(
        `📢 Admin broadcast sent: ${sent}/${users.length} delivered, ${failed} failed.`,
      );
      return res.json({
        message: `Broadcast sent to ${sent} of ${users.length} users.${
          failed > 0 ? ` (${failed} failed to deliver)` : ""
        }`,
        sent,
        failed,
      });
    }

    // ── Direct message to a specific user ──────────────────────────────────────
    if (!userId) {
      return res
        .status(400)
        .json({ message: "userId is required for direct messages." });
    }

    const userRes = await db.query(
      "SELECT id, name, email FROM users WHERE id = $1",
      [userId],
    );
    if (!userRes.rows.length) {
      return res.status(404).json({ message: "User not found." });
    }
    const user = userRes.rows[0];

    await sgMail.send({
      to: user.email,
      from: { name: BRAND.name, email: BRAND.supportEmail },
      subject: subject.trim(),
      html: emailWrap(
        `<p style="margin:0 0 16px;font-size:15px;color:#0f172a;">Hi <strong>${user.name}</strong>,</p>` +
          bodyHtml +
          `<p style="margin:16px 0 0;font-size:13px;color:#64748b;">— The ${BRAND.name} Team</p>`,
        { subtitle: "Message from Fonlok" },
      ),
    });

    await db.query(
      `INSERT INTO admin_broadcasts
         (recipient_type, recipient_user_id, recipient_email, subject, body, recipients_count)
       VALUES ($1, $2, $3, $4, $5, 1)`,
      ["user", user.id, user.email, subject.trim(), body.trim()],
    );

    console.log(`📩 Admin direct message sent to ${user.email}.`);
    return res.json({
      message: `Message sent to ${user.name} (${user.email}).`,
    });
  } catch (err) {
    console.error("Admin broadcast error:", err);
    res
      .status(500)
      .json({ message: "Failed to send message. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/broadcasts?page=1&limit=10
// Paginated history of all admin-sent broadcasts and direct messages
// ─────────────────────────────────────────────────────────────────────────────
router.get("/broadcasts", adminMiddleware, async (req, res) => {
  const { page, limit, offset } = getPagination(req.query);

  try {
    const [dataResult, countResult] = await Promise.all([
      db.query(
        `SELECT
           b.id,
           b.recipient_type,
           b.recipient_email,
           b.subject,
           b.body,
           b.recipients_count,
           b.sent_at,
           u.name     AS recipient_name,
           u.username AS recipient_username
         FROM admin_broadcasts b
         LEFT JOIN users u ON u.id = b.recipient_user_id
         ORDER BY b.sent_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      db.query("SELECT COUNT(*) FROM admin_broadcasts"),
    ]);

    const total = parseInt(countResult.rows[0].count);

    res.json({
      data: dataResult.rows,
      total,
      page,
      hasMore: offset + limit < total,
    });
  } catch (err) {
    console.error("Admin broadcasts history error:", err);
    res.status(500).json({ message: "Failed to load message history." });
  }
});

export default router;
