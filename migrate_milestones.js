/**
 * Migration: Add installment / milestone payment support
 *
 * Run once with: node migrate_milestones.js
 *
 * Safe to run multiple times — uses IF NOT EXISTS and ON CONFLICT DO NOTHING.
 */
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

const db = new Client({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  ssl: false,
});

await db.connect();

try {
  // 1. Add payment_type column to invoices (defaults to 'full' — no existing rows break)
  await db.query(`
    ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS payment_type VARCHAR(20) NOT NULL DEFAULT 'full';
  `);
  console.log("✅ invoices.payment_type column ready");

  // 2. Create invoice_milestones table
  await db.query(`
    CREATE TABLE IF NOT EXISTS invoice_milestones (
      id                SERIAL PRIMARY KEY,
      invoice_id        INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      invoice_number    VARCHAR(255) NOT NULL,
      milestone_number  INTEGER NOT NULL CHECK (milestone_number > 0),
      label             VARCHAR(255) NOT NULL,
      amount            INTEGER NOT NULL CHECK (amount > 0),
      deadline          DATE,

      -- States:
      --   pending    → waiting for seller to mark it complete
      --   completed  → seller marked it done, email sent to buyer with release link
      --   released   → buyer confirmed, payout sent to seller
      --   disputed   → buyer opened a dispute on this milestone
      status            VARCHAR(20) NOT NULL DEFAULT 'pending',

      release_token     VARCHAR(255) UNIQUE, -- one-time token embedded in the buyer's email link
      completed_at      TIMESTAMP,
      released_at       TIMESTAMP,

      created_at        TIMESTAMP NOT NULL DEFAULT NOW(),

      UNIQUE (invoice_id, milestone_number)
    );
  `);
  console.log("✅ invoice_milestones table ready");

  // 3. Index for fast lookup by invoice_id
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_milestones_invoice_id
    ON invoice_milestones (invoice_id);
  `);
  console.log("✅ index on invoice_milestones.invoice_id ready");

  console.log("\n🎉 Migration complete — all milestone tables are ready.");
} catch (err) {
  console.error("❌ Migration failed:", err.message);
} finally {
  await db.end();
}
