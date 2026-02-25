/**
 * notifications.js
 *
 * Handles in-app notifications and browser push subscriptions.
 *
 * Routes:
 *   GET    /notifications                — fetch your notifications (newest first)
 *   PATCH  /notifications/read-all      — mark every unread notification as read
 *   PATCH  /notifications/:id/read      — mark one notification as read
 *   POST   /notifications/subscribe     — save your browser push subscription
 *   DELETE /notifications/unsubscribe   — remove your push subscription
 *   GET    /notifications/vapid-public-key — return the VAPID public key to the browser
 */

import express from "express";
const router = express.Router();
import db from "../controllers/db.js";
import authMiddleware from "../middleware/authMiddleware.js";
import webpush from "web-push";
import dotenv from "dotenv";
dotenv.config();

// ── Configure VAPID ────────────────────────────────────────────────────────────
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || "support@fonlok.com"}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

// ── Auto-create tables on first boot ────────────────────────────────────────────
const ensureTables = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id         SERIAL PRIMARY KEY,
      userid     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type       VARCHAR(60)  NOT NULL,
      title      VARCHAR(200) NOT NULL,
      body       TEXT         NOT NULL,
      data       JSONB        DEFAULT '{}',
      is_read    BOOLEAN      DEFAULT false,
      created_at TIMESTAMP    DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id           SERIAL PRIMARY KEY,
      userid       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subscription JSONB   NOT NULL,
      created_at   TIMESTAMP DEFAULT NOW(),
      UNIQUE(userid)
    )
  `);
  // Index for fast per-user lookups
  await db.query(`
    CREATE INDEX IF NOT EXISTS notifications_userid_idx ON notifications(userid)
  `);
};
ensureTables().catch((e) =>
  console.error("⚠️  Notifications table setup error:", e.message),
);

// ── GET /notifications ─────────────────────────────────────────────────────────
// Returns the 50 most recent notifications for the logged-in user.
router.get("/", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await db.query(
      `SELECT id, type, title, body, data, is_read, created_at
         FROM notifications
        WHERE userid = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [userId],
    );
    const unreadCount = result.rows.filter((n) => !n.is_read).length;
    return res.json({ notifications: result.rows, unreadCount });
  } catch (err) {
    console.error("GET /notifications error:", err.message);
    return res.status(500).json({ message: "Could not load notifications." });
  }
});

// ── PATCH /notifications/read-all ─────────────────────────────────────────────
// Marks every unread notification for the current user as read.
router.patch("/read-all", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  try {
    await db.query(
      "UPDATE notifications SET is_read = true WHERE userid = $1 AND is_read = false",
      [userId],
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /notifications/read-all error:", err.message);
    return res.status(500).json({ message: "Could not update notifications." });
  }
});

// ── PATCH /notifications/:id/read ─────────────────────────────────────────────
// Marks a single notification as read (only if it belongs to the current user).
router.patch("/:id/read", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;
  try {
    await db.query(
      "UPDATE notifications SET is_read = true WHERE id = $1 AND userid = $2",
      [id, userId],
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /notifications/:id/read error:", err.message);
    return res.status(500).json({ message: "Could not update notification." });
  }
});

// ── POST /notifications/subscribe ─────────────────────────────────────────────
// Saves (or updates) the browser push subscription for this user.
router.post("/subscribe", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { subscription } = req.body;
  if (!subscription)
    return res.status(400).json({ message: "Subscription data is required." });

  try {
    await db.query(
      `INSERT INTO push_subscriptions (userid, subscription)
       VALUES ($1, $2)
       ON CONFLICT (userid)
       DO UPDATE SET subscription = EXCLUDED.subscription, created_at = NOW()`,
      [userId, JSON.stringify(subscription)],
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /notifications/subscribe error:", err.message);
    return res.status(500).json({ message: "Could not save subscription." });
  }
});

// ── DELETE /notifications/unsubscribe ─────────────────────────────────────────
// Removes the push subscription (called when user denies permission).
router.delete("/unsubscribe", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  try {
    await db.query("DELETE FROM push_subscriptions WHERE userid = $1", [
      userId,
    ]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /notifications/unsubscribe error:", err.message);
    return res.status(500).json({ message: "Could not remove subscription." });
  }
});

// ── GET /notifications/vapid-public-key ────────────────────────────────────────
// The browser needs the VAPID public key before it can subscribe.
// This is safe to expose publicly — the private key never leaves the server.
router.get("/vapid-public-key", (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key)
    return res
      .status(503)
      .json({
        message: "Push notifications are not configured on this server.",
      });
  return res.json({ publicKey: key });
});

export default router;
