/**
 * Passkey / Biometric Authentication Routes  (WebAuthn / FIDO2)
 *
 * Implements a full WebAuthn registration + authentication ceremony using
 * @simplewebauthn/server.
 *
 * Endpoints:
 *   POST /passkey/register-challenge   — generate registration options (authenticated)
 *   POST /passkey/register-verify      — verify & store the new credential (authenticated)
 *   POST /passkey/auth-challenge       — generate authentication options (public)
 *   POST /passkey/auth-verify          — verify assertion & issue JWT (public)
 *   GET  /passkey/list                 — list registered passkeys (authenticated)
 *   DELETE /passkey/:id                — remove a passkey (authenticated)
 *
 * Challenge storage:
 *   Challenges are kept in-memory with a 5-minute TTL.  This is sufficient for
 *   a single-process deployment.  If you run multiple processes add a shared
 *   Redis/Postgres backing store instead.
 */

import express from "express";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import db from "../controllers/db.js";
import jwt from "jsonwebtoken";
import authMiddleware from "../middleware/authMiddleware.js";
import logger from "../utils/logger.js";

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

const RP_NAME = "Fonlok";

/**
 * Derive the WebAuthn Relying Party origin.
 * Must exactly match window.location.origin on the frontend.
 */
function getOrigin() {
  return (process.env.FRONTEND_URL || "http://localhost:3000").replace(
    /\/$/,
    "",
  );
}

/**
 * Derive the WebAuthn Relying Party ID (hostname only, no scheme or port).
 */
function getRpId() {
  try {
    return new URL(getOrigin()).hostname;
  } catch {
    return "localhost";
  }
}

// ── In-memory challenge store ─────────────────────────────────────────────────
// key → { challenge: string, timestamp: number, userId?: number }
const challengeStore = new Map();
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Purge stale challenges every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - CHALLENGE_TTL_MS;
  for (const [key, val] of challengeStore.entries()) {
    if (val.timestamp < cutoff) challengeStore.delete(key);
  }
}, CHALLENGE_TTL_MS);

// ── Ensure the passkey_credentials table exists ───────────────────────────────
// Runs once at startup — safe for multiple deploys (CREATE TABLE IF NOT EXISTS).
async function ensureTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS passkey_credentials (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        credential_id TEXT    NOT NULL UNIQUE,
        public_key    TEXT    NOT NULL,
        counter       BIGINT  NOT NULL DEFAULT 0,
        transports    TEXT[]  DEFAULT '{}',
        device_name   TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_passkey_user_id
        ON passkey_credentials (user_id)
    `);
    logger.info("passkey_credentials table ready");
  } catch (err) {
    logger.error("Failed to create passkey_credentials table", {
      error: err.message,
    });
  }
}
ensureTable();

// ── 1. Register — challenge ───────────────────────────────────────────────────
router.post("/register-challenge", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const [userResult, existingResult] = await Promise.all([
      db.query("SELECT username, email FROM users WHERE id = $1", [userId]),
      db.query(
        "SELECT credential_id, transports FROM passkey_credentials WHERE user_id = $1",
        [userId],
      ),
    ]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }
    const user = userResult.rows[0];

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: getRpId(),
      userName: user.email,
      userID: new TextEncoder().encode(String(userId)),
      userDisplayName: user.username || user.email,
      attestationType: "none",
      excludeCredentials: existingResult.rows.map((row) => ({
        id: row.credential_id,
        transports: row.transports ?? [],
      })),
      authenticatorSelection: {
        // "platform" = built-in sensor (Touch ID, Face ID, Windows Hello, Android biometric)
        authenticatorAttachment: "platform",
        // "preferred" stores the credential on-device (discoverable / resident key)
        residentKey: "preferred",
        userVerification: "required",
      },
    });

    challengeStore.set(`reg:${userId}`, {
      challenge: options.challenge,
      timestamp: Date.now(),
    });

    return res.json(options);
  } catch (err) {
    logger.error("passkey register-challenge", { error: err.message });
    return res
      .status(500)
      .json({ message: "Failed to start biometric registration." });
  }
});

// ── 2. Register — verify ──────────────────────────────────────────────────────
router.post("/register-verify", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const stored = challengeStore.get(`reg:${userId}`);

    if (!stored) {
      return res.status(400).json({
        message: "Registration session expired. Please start again.",
      });
    }

    const { deviceName, ...regResponse } = req.body;

    const { verified, registrationInfo } = await verifyRegistrationResponse({
      response: regResponse,
      expectedChallenge: stored.challenge,
      expectedOrigin: getOrigin(),
      expectedRPID: getRpId(),
      requireUserVerification: true,
    });

    if (!verified || !registrationInfo) {
      return res
        .status(400)
        .json({ message: "Biometric verification failed. Please try again." });
    }

    const { credential } = registrationInfo;

    // Store the credential — public key as base64 string
    await db.query(
      `INSERT INTO passkey_credentials
         (user_id, credential_id, public_key, counter, transports, device_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (credential_id) DO UPDATE
         SET counter = EXCLUDED.counter,
             device_name = EXCLUDED.device_name`,
      [
        userId,
        credential.id,
        Buffer.from(credential.publicKey).toString("base64"),
        credential.counter,
        regResponse.response?.transports ?? [],
        deviceName ?? null,
      ],
    );

    challengeStore.delete(`reg:${userId}`);
    logger.info("passkey registered", { userId });

    return res.json({ verified: true });
  } catch (err) {
    logger.error("passkey register-verify", { error: err.message });
    return res
      .status(500)
      .json({ message: "Failed to complete biometric registration." });
  }
});

// ── 3. Auth — challenge ───────────────────────────────────────────────────────
// Discoverable / resident-key flow: no email required.
// The device will present the stored credential without server hints.
router.post("/auth-challenge", async (req, res) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID: getRpId(),
      userVerification: "required",
      allowCredentials: [], // empty = discoverable — device discovers the credential itself
    });

    // Key the challenge by its own value so we can look it up during verify
    challengeStore.set(`auth:${options.challenge}`, {
      challenge: options.challenge,
      timestamp: Date.now(),
    });

    return res.json(options);
  } catch (err) {
    logger.error("passkey auth-challenge", { error: err.message });
    return res
      .status(500)
      .json({ message: "Failed to start biometric authentication." });
  }
});

// ── 4. Auth — verify ──────────────────────────────────────────────────────────
router.post("/auth-verify", async (req, res) => {
  try {
    // Extract the challenge from clientDataJSON so we can find the stored challenge
    const clientDataRaw = Buffer.from(
      req.body.response?.clientDataJSON ?? "",
      "base64",
    ).toString("utf8");
    const clientData = JSON.parse(clientDataRaw);

    // The challenge in clientDataJSON is base64url — same value we stored
    const storedEntry = challengeStore.get(`auth:${clientData.challenge}`);
    if (!storedEntry) {
      return res.status(400).json({
        message: "Authentication session expired. Please try again.",
      });
    }

    // Discover which user owns this credential via userHandle
    // (userHandle = TextEncoder.encode(String(userId)) set at registration time)
    const userHandleB64 = req.body.response?.userHandle;
    if (!userHandleB64) {
      return res
        .status(400)
        .json({ message: "Credential does not identify a user." });
    }

    const userIdStr = Buffer.from(userHandleB64, "base64url").toString("utf8");
    const userId = parseInt(userIdStr, 10);
    if (isNaN(userId)) {
      return res.status(400).json({ message: "Invalid credential data." });
    }

    // Find the credential in the database
    const credResult = await db.query(
      `SELECT * FROM passkey_credentials
       WHERE credential_id = $1 AND user_id = $2`,
      [req.body.id, userId],
    );

    if (credResult.rows.length === 0) {
      // Generic message — do not reveal which part failed
      return res.status(401).json({ message: "Biometric sign-in failed." });
    }

    const dbCred = credResult.rows[0];

    const { verified, authenticationInfo } = await verifyAuthenticationResponse(
      {
        response: req.body,
        expectedChallenge: storedEntry.challenge,
        expectedOrigin: getOrigin(),
        expectedRPID: getRpId(),
        requireUserVerification: true,
        credential: {
          id: dbCred.credential_id,
          publicKey: Buffer.from(dbCred.public_key, "base64"),
          counter: dbCred.counter,
          transports: dbCred.transports ?? [],
        },
      },
    );

    if (!verified) {
      return res.status(401).json({ message: "Biometric sign-in failed." });
    }

    // Update replay-attack counter
    await db.query(
      "UPDATE passkey_credentials SET counter = $1 WHERE credential_id = $2",
      [authenticationInfo.newCounter, dbCred.credential_id],
    );

    challengeStore.delete(`auth:${clientData.challenge}`);

    // Fetch user details for the response
    const userResult = await db.query(
      "SELECT id, username FROM users WHERE id = $1",
      [userId],
    );
    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: "Biometric sign-in failed." });
    }
    const user = userResult.rows[0];

    // Issue the same JWT as the password login route
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: "6h",
    });

    const isHttps = process.env.BACKEND_URL?.startsWith("https");
    res.cookie("authToken", token, {
      httpOnly: true,
      secure: isHttps,
      sameSite: isHttps ? "none" : "lax",
      maxAge: 6 * 60 * 60 * 1000,
    });

    logger.info("passkey authentication", { userId: user.id });

    return res.json({
      message: "Signed in successfully.",
      userId: user.id,
      username: user.username,
      token,
    });
  } catch (err) {
    logger.error("passkey auth-verify", { error: err.message });
    return res.status(401).json({ message: "Biometric sign-in failed." });
  }
});

// ── 5. List registered passkeys (for settings page) ──────────────────────────
router.get("/list", authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, device_name, created_at
       FROM passkey_credentials
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id],
    );
    return res.json({ passkeys: result.rows });
  } catch (err) {
    return res.status(500).json({ message: "Failed to list passkeys." });
  }
});

// ── 6. Remove a passkey ───────────────────────────────────────────────────────
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      "DELETE FROM passkey_credentials WHERE id = $1 AND user_id = $2 RETURNING id",
      [req.params.id, req.user.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Passkey not found." });
    }
    return res.json({ message: "Passkey removed." });
  } catch (err) {
    return res.status(500).json({ message: "Failed to remove passkey." });
  }
});

export default router;
