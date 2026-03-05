/**
 * migrate_dispute_milestones.js
 *
 * Adds milestone-aware dispute columns to the disputes table and
 * adds a dispute_resolution tracking column to invoice_milestones.
 *
 * Run once:  node migrate_dispute_milestones.js
 */

import db from "./src/controllers/db.js";

async function migrate() {
  console.log("Running milestone-dispute migration…");

  await db.query(`
    ALTER TABLE disputes
      ADD COLUMN IF NOT EXISTS dispute_scope       VARCHAR(20)  DEFAULT 'full',
      ADD COLUMN IF NOT EXISTS disputed_milestone_ids INTEGER[]  DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS disputed_amount     NUMERIC      DEFAULT NULL;
  `);
  console.log("✅ disputes table updated.");

  await db.query(`
    ALTER TABLE invoice_milestones
      ADD COLUMN IF NOT EXISTS dispute_resolution VARCHAR(20) DEFAULT NULL;
    -- Possible values: 'seller' (funds sent to seller via dispute)
    --                  'buyer'  (refunded to buyer via dispute)
  `);
  console.log("✅ invoice_milestones table updated.");

  console.log("Migration complete.");
  process.exit(0);
}

migrate().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
