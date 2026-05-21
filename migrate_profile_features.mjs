/**
 * migrate_profile_features.mjs
 * Run once: node backend/migrate_profile_features.mjs
 * Adds bio, tags, and review-enhancement columns.
 */
import pg from "pg";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env") });

const { Pool } = pg;
const isProduction = process.env.NODE_ENV === "production";

const db = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: isProduction ? { rejectUnauthorized: false } : false,
      }
    : {
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME,
        ssl: isProduction ? { rejectUnauthorized: false } : false,
      },
);

try {
  // ── users: bio + tags ──────────────────────────────────────────────────────
  await db.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS bio  VARCHAR(160) DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS tags TEXT[]       DEFAULT '{}';
  `);
  console.log("✓ users: bio + tags columns added.");

  // ── reviews: pin, seller reply, invoice name disclosure ───────────────────
  await db.query(`
    ALTER TABLE reviews
      ADD COLUMN IF NOT EXISTS pinned             BOOLEAN     DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS seller_reply       TEXT        DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS reply_created_at   TIMESTAMPTZ DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS show_invoice_name  BOOLEAN     DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS invoice_name       TEXT        DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS invoice_amount     NUMERIC     DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS invoice_currency   VARCHAR(10) DEFAULT NULL;
  `);
  console.log("✓ reviews: pin, reply, invoice-name columns added.");

  await db.end();
  console.log("Migration complete.");
} catch (err) {
  console.error("Migration failed:", err.message);
  await db.end();
  process.exit(1);
}
