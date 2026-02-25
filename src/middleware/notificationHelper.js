/**
 * notificationHelper.js
 *
 * Single function `notifyUser(userId, type, title, body, data)` that:
 *   1. Saves the notification to the DB (in-app bell)
 *   2. Sends a browser push notification if the user has subscribed
 *
 * Call it anywhere in your routes — it NEVER throws, so a notification
 * failure will never crash your main route logic.
 *
 * Notification types used across the app:
 *   invoice_paid       — buyer paid your invoice
 *   payout_sent        — funds sent to your Mobile Money
 *   dispute_opened     — a dispute was opened on one of your invoices
 *   milestone_complete — seller marked a milestone as complete
 *   milestone_released — a milestone payout was sent
 *   new_message        — someone sent you a chat message
 *   delivered_marked   — seller marked invoice as delivered
 *   referral_earned    — you earned a referral commission
 */

import db from "../controllers/db.js";
import webpush from "web-push";

// Configure VAPID — these keys come from your .env file.
// Run `node generate-vapid-keys.mjs` once to generate them.
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || "support@fonlok.com"}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

/**
 * notifyUser — creates a DB notification and sends a browser push.
 *
 * @param {number} userId  - The ID of the user to notify (must be a registered user)
 * @param {string} type    - Notification type (e.g. "invoice_paid")
 * @param {string} title   - Short title shown in the bell and the push
 * @param {string} body    - Longer description message
 * @param {object} data    - Optional extra data (e.g. { invoiceNumber, amount })
 */
export const notifyUser = async (userId, type, title, body, data = {}) => {
  if (!userId) return; // Guard: never try to notify a guest/undefined user

  try {
    // ── 1. Save to the notifications table ───────────────────────────────────
    await db.query(
      `INSERT INTO notifications (userid, type, title, body, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, type, title, body, JSON.stringify(data)],
    );

    // ── 2. Send browser push if the user has a saved subscription ────────────
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      // VAPID keys not configured yet — skip push, in-app only
      return;
    }

    const subResult = await db.query(
      "SELECT subscription FROM push_subscriptions WHERE userid = $1",
      [userId],
    );

    if (subResult.rows.length > 0) {
      const subscription = subResult.rows[0].subscription;
      const payload = JSON.stringify({ title, body, type, data });

      await webpush
        .sendNotification(subscription, payload)
        .catch(async (err) => {
          // 410 Gone / 404 = subscription expired or invalid → remove it
          if (err.statusCode === 410 || err.statusCode === 404) {
            await db
              .query("DELETE FROM push_subscriptions WHERE userid = $1", [
                userId,
              ])
              .catch(() => {});
          }
          console.error(`⚠️  Push error for user ${userId}:`, err.message);
        });
    }
  } catch (err) {
    // NEVER let a notification failure break the calling route
    console.error(`⚠️  notifyUser error (user ${userId}):`, err.message);
  }
};
