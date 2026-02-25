import pg from "pg";
import dotenv from "dotenv";
import logger from "../utils/logger.js";
dotenv.config();

const { Pool } = pg;

// Use a connection pool instead of a single Client.
// Pool automatically manages a set of reusable connections so that
// concurrent requests don't wait on each other or exhaust the DB.
const isProduction = process.env.NODE_ENV === "production";

const db = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  max: 20, // max simultaneous connections in the pool
  idleTimeoutMillis: 30_000, // close idle connections after 30 s
  connectionTimeoutMillis: 5_000, // fail fast if no free connection after 5 s
});

// Log unexpected pool errors so they don't silently swallow the reason
// a query failed (the default behaviour logs nothing).
db.on("error", (err) => {
  logger.error("Unexpected DB pool error", { error: err.message });
});

export default db;
