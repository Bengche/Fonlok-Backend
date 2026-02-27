/**
 * uploads.js — LEGACY file-serving route
 *
 * New media (profile pictures, chat attachments) is stored on Cloudinary and
 * served directly via Cloudinary's CDN — this route is no longer called for
 * new uploads.
 *
 * Kept for backward compatibility: file URLs generated before the Cloudinary
 * migration that still resolve to a local disk path will be served from here.
 *
 * Auth: cookie/Bearer JWT (sellers/admins) or ?token=&invoice= (buyers).
 */
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
import logger from "../utils/logger.js";
import db from "../controllers/db.js";

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_DIR = path.resolve(__dirname, "../../uploads");

// GET /uploads/:filename
// Serves uploaded files to:
//   1. Authenticated users (sellers/admins) — verified via httpOnly cookie or
//      Authorization header (JWT).
//   2. Buyers accessing a chat attachment — verified via ?token=<chat_token>
//      &invoice=<invoicenumber> query params validated against the guests table.
router.get("/:filename", async (req, res) => {
  // path.basename strips any ../ directory traversal attempts
  const filename = path.basename(req.params.filename);
  const filepath = path.join(UPLOADS_DIR, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: "File not found" });
  }

  // ── Auth path 1: cookie / Bearer JWT (seller / admin) ────────────────────
  // We do the JWT check manually here so we can fall through to token auth
  // without sending a 401 prematurely (authMiddleware sends the response itself
  // and gives us no way to recover after it does so).
  let jwtToken = req.cookies?.authToken || req.cookies?.token;
  if (!jwtToken) {
    const authHeader =
      req.headers["authorization"] || req.headers["Authorization"];
    if (authHeader?.startsWith("Bearer ")) {
      const candidate = authHeader.slice(7);
      if (candidate && candidate !== "undefined" && candidate !== "null") {
        jwtToken = candidate;
      }
    }
  }
  if (jwtToken) {
    try {
      jwt.verify(jwtToken, process.env.JWT_SECRET);
      logger.info("file served (cookie/JWT auth)", { filename });
      return res.sendFile(filepath);
    } catch (_) {
      // JWT invalid or expired — fall through to buyer token auth
    }
  }

  // ── Auth path 2: chat token (buyer guest) ────────────────────────────────
  const { token, invoice } = req.query;
  if (token && invoice) {
    try {
      const guest = await db.query(
        "SELECT 1 FROM guests WHERE invoicenumber = $1 AND chat_token = $2",
        [invoice, token],
      );
      if (guest.rows.length > 0) {
        logger.info("file served (chat token)", { filename, invoice });
        return res.sendFile(filepath);
      }
    } catch (err) {
      logger.error("token auth failed for upload", { error: err.message });
    }
  }

  return res.status(401).json({ error: "Authentication required" });
});

export default router;
