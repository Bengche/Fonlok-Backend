import express from "express";
const router = express.Router();
import axios from "axios";
import dotenv from "dotenv";
import db from "../controllers/db.js";
import authMiddleware from "../middleware/authMiddleware.js";
dotenv.config();

// ── Auto-migrations: ensure all referral tables and columns exist ─────────────

// ── Auto-migrations: run sequentially and block module load until complete ───
// ESM top-level await ensures every migration finishes before Express can
// serve any request through this router, so route queries never hit a missing
// table or column.

try {
  await db.query(
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE",
  );
} catch (e) {
  console.error("⚠️  referral_code column:", e.message);
}

try {
  await db.query(
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_balance INTEGER NOT NULL DEFAULT 0",
  );
} catch (e) {
  console.error("⚠️  referral_balance column:", e.message);
}

try {
  await db.query(
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER REFERENCES users(id)",
  );
} catch (e) {
  console.error("⚠️  referred_by column:", e.message);
}

try {
  await db.query(`
    CREATE TABLE IF NOT EXISTS referral_earnings (
      id               SERIAL PRIMARY KEY,
      referrer_userid  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referred_userid  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invoice_number   TEXT    NOT NULL,
      invoice_amount   NUMERIC NOT NULL,
      earned_amount    NUMERIC NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
} catch (e) {
  console.error("⚠️  referral_earnings table:", e.message);
}

try {
  await db.query(`
    CREATE TABLE IF NOT EXISTS referral_withdrawals (
      id           SERIAL PRIMARY KEY,
      userid       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount       NUMERIC NOT NULL,
      momo_number  TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'pending',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
} catch (e) {
  console.error("⚠️  referral_withdrawals table:", e.message);
}

// Backfill referral codes for any existing accounts that don't have one yet
try {
  await db.query(`
    DO $$
    DECLARE
      u RECORD;
      code TEXT;
    BEGIN
      FOR u IN SELECT id FROM users WHERE referral_code IS NULL LOOP
        LOOP
          code := upper(left(md5(random()::text || u.id::text || clock_timestamp()::text), 6));
          BEGIN
            UPDATE users SET referral_code = code WHERE id = u.id;
            EXIT;
          EXCEPTION WHEN unique_violation THEN
            NULL;
          END;
        END LOOP;
      END LOOP;
    END $$;
  `);
} catch (e) {
  console.error("⚠️  referral code backfill:", e.message);
}

console.log("✅  Referral migrations complete.");

const MIN_WITHDRAWAL_AMOUNT = 2000; // XAF

// ─────────────────────────────────────────────────────────────────────────────
// GET /referral/dashboard
// Returns everything a user needs to see on their referral dashboard:
//   - Their personal referral code and shareable link
//   - Current balance (in XAF)
//   - Full earnings history with invoice details
//   - List of users they have referred
//   - Withdrawal history
// ─────────────────────────────────────────────────────────────────────────────
router.get("/dashboard", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    // 1. Fetch this user's referral info
    const userResult = await db.query(
      "SELECT referral_code, referral_balance FROM users WHERE id = $1",
      [userId],
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const { referral_code, referral_balance } = userResult.rows[0];
    const referralLink = `${process.env.FRONTEND_URL}/register?ref=${referral_code}`;

    // 2. Fetch earnings history — join to users table to show the referred person's name
    const earningsResult = await db.query(
      `SELECT
         re.id,
         re.invoice_number,
         re.invoice_amount,
         re.earned_amount,
         re.created_at,
         u.name AS referred_user_name,
         u.username AS referred_user_username
       FROM referral_earnings re
       JOIN users u ON u.id = re.referred_userid
       WHERE re.referrer_userid = $1
       ORDER BY re.created_at DESC`,
      [userId],
    );

    // 3. Fetch list of users this person has referred
    const referredUsersResult = await db.query(
      `SELECT id, name, username
       FROM users
       WHERE referred_by = $1
       ORDER BY id DESC`,
      [userId],
    );

    // 4. Fetch withdrawal history
    const withdrawalsResult = await db.query(
      `SELECT id, amount, momo_number, status, created_at
       FROM referral_withdrawals
       WHERE userid = $1
       ORDER BY created_at DESC`,
      [userId],
    );

    res.json({
      referral_code,
      referral_link: referralLink,
      balance: referral_balance,
      min_withdrawal: MIN_WITHDRAWAL_AMOUNT,
      earnings: earningsResult.rows,
      referred_users: referredUsersResult.rows,
      withdrawals: withdrawalsResult.rows,
    });
  } catch (err) {
    console.error("❌  Referral dashboard error:", err.message, err.stack);
    res.status(500).json({ error: "Failed to load referral dashboard." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /referral/withdraw
// Allows a user to withdraw their referral balance to their MoMo number.
//
// Safety rules enforced:
//   1. User must be authenticated
//   2. Amount must be at least 2,000 XAF
//   3. Amount cannot exceed the user's current balance
//   4. User cannot have another withdrawal already in 'pending' state
//   5. Balance is deducted atomically before calling Campay, and restored on failure
// ─────────────────────────────────────────────────────────────────────────────
router.post("/withdraw", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { amount, momo_number } = req.body;

  // --- Input Validation ---
  if (!amount || !momo_number) {
    return res
      .status(400)
      .json({ error: "Amount and MoMo number are required." });
  }

  const withdrawAmount = parseInt(amount, 10);

  if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
    return res.status(400).json({ error: "Amount must be a positive number." });
  }

  if (withdrawAmount < MIN_WITHDRAWAL_AMOUNT) {
    return res.status(400).json({
      error: `Minimum withdrawal amount is ${MIN_WITHDRAWAL_AMOUNT.toLocaleString()} XAF.`,
    });
  }

  const momoClean = String(momo_number).trim();
  if (!/^237[62]\d{8}$/.test(momoClean)) {
    return res.status(400).json({
      error:
        "Please provide a valid Cameroonian MoMo number (e.g. 2376XXXXXXXX).",
    });
  }

  try {
    // ── Atomic deduction — closes the TOCTOU race-condition window ──────────
    // Replaces three separate queries (read balance, check pending, deduct)
    // that previously had a race window between them.  Now a single UPDATE
    // enforces ALL conditions atomically:
    //   a) balance must be sufficient, AND
    //   b) no 'pending' withdrawal already exists for this user.
    // If two concurrent requests reach this point simultaneously, exactly one
    // gets a RETURNING row and continues; the other gets 0 rows and returns an
    // error — before any money moves.
    const deductResult = await db.query(
      `UPDATE users
          SET referral_balance = referral_balance - $1
        WHERE id = $2
          AND referral_balance >= $1
          AND NOT EXISTS (
            SELECT 1 FROM referral_withdrawals
             WHERE userid = $2 AND status = 'pending'
          )
        RETURNING referral_balance`,
      [withdrawAmount, userId],
    );

    if (deductResult.rows.length === 0) {
      // Determine the exact reason so we can return a precise error message.
      // (This read is non-critical — the deduction definitely did NOT happen.)
      const recheckResult = await db.query(
        `SELECT referral_balance,
                (SELECT COUNT(*) FROM referral_withdrawals
                  WHERE userid = $1 AND status = 'pending') AS pending_count
           FROM users WHERE id = $1`,
        [userId],
      );
      if (recheckResult.rows.length === 0) {
        return res.status(404).json({ error: "User not found." });
      }
      const rc = recheckResult.rows[0];
      if (parseInt(rc.pending_count) > 0) {
        return res.status(400).json({
          error:
            "You already have a pending withdrawal. Please wait for it to be processed before requesting another.",
        });
      }
      return res.status(400).json({
        error: `Insufficient balance. You have ${Number(rc.referral_balance).toLocaleString()} XAF available.`,
      });
    }

    // 5. Log the withdrawal as 'pending' before calling Campay
    const withdrawalRecord = await db.query(
      "INSERT INTO referral_withdrawals (userid, amount, momo_number, status) VALUES ($1, $2, $3, 'pending') RETURNING id",
      [userId, withdrawAmount, momoClean],
    );
    const withdrawalId = withdrawalRecord.rows[0].id;

    // 6. Call Campay to transfer the money
    try {
      const auth = await axios.post(`${process.env.CAMPAY_BASE_URL}token/`, {
        username: process.env.CAMPAY_USERNAME,
        password: process.env.CAMPAY_PASSWORD,
      });

      await axios.post(
        `${process.env.CAMPAY_BASE_URL}withdraw/`,
        {
          amount: withdrawAmount.toString(),
          currency: "XAF",
          to: momoClean,
          description: "Referral earnings withdrawal",
          external_reference: `ref-withdrawal-${withdrawalId}`,
        },
        { headers: { Authorization: `Token ${auth.data.token}` } },
      );

      // 7. Mark withdrawal as paid
      await db.query(
        "UPDATE referral_withdrawals SET status = 'paid' WHERE id = $1",
        [withdrawalId],
      );

      console.log(
        `✅ Referral withdrawal of ${withdrawAmount} XAF paid to ${momoClean} for user ${userId}`,
      );

      res.json({
        message: `Your withdrawal of ${withdrawAmount.toLocaleString()} XAF has been sent to ${momoClean}. It should arrive within a few minutes.`,
      });
    } catch (campayErr) {
      // Campay call failed — restore the user's balance and mark the withdrawal as failed
      console.error("Campay referral withdrawal failed:", campayErr.message);

      await db.query(
        "UPDATE users SET referral_balance = referral_balance + $1 WHERE id = $2",
        [withdrawAmount, userId],
      );

      await db.query(
        "UPDATE referral_withdrawals SET status = 'failed' WHERE id = $1",
        [withdrawalId],
      );

      res.status(502).json({
        error:
          "The payment gateway could not process your withdrawal. Your balance has been restored. Please try again later.",
      });
    }
  } catch (err) {
    console.error("Referral withdrawal error:", err);
    res
      .status(500)
      .json({ error: "An unexpected error occurred. Please try again." });
  }
});

export default router;
