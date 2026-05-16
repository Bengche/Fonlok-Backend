import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pg;
const db = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

const result = await db.query(`
  SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
`);
console.log("Tables:", result.rows.map(r => r.tablename).join(", "));
await db.end();
