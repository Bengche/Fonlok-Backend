import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pg;
const isProduction = process.env.NODE_ENV === "production";
const db = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
});

try {
  await db.query(`
    ALTER TABLE disputes
      ADD COLUMN IF NOT EXISTS dispute_scope          VARCHAR(20)  DEFAULT 'full',
      ADD COLUMN IF NOT EXISTS disputed_milestone_ids INTEGER[]    DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS disputed_amount        NUMERIC      DEFAULT NULL;
  `);
  console.log("✅ disputes table updated.");

  await db.query(`
    ALTER TABLE invoice_milestones
      ADD COLUMN IF NOT EXISTS dispute_resolution VARCHAR(20) DEFAULT NULL;
  `);
  console.log("✅ invoice_milestones table updated.");

  console.log("Migration complete.");
} catch (err) {
  console.error("Migration failed:", err.message);
  process.exit(1);
} finally {
  await db.end();
}
