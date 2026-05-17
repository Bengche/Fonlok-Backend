import crypto from "crypto";
import jwt from "jsonwebtoken";
import sgMail from "@sendgrid/mail";
import db from "../controllers/db.js";
import logger from "./logger.js";
import { emailWrap, emailButton, emailTable } from "./emailTemplate.js";

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;

if (process.env.SENDGRID_API_KEY?.startsWith("SG.")) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

db.query(
  `
  CREATE TABLE IF NOT EXISTS user_sessions (
    sid TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    login_method TEXT NOT NULL DEFAULT 'password',
    browser TEXT,
    os TEXT,
    device_type TEXT,
    location_label TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
  )
`,
).catch((err) => {
  logger.error("user_sessions migration error", { error: err.message });
});

db.query(
  `
  CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active
  ON user_sessions (user_id, revoked_at, last_active_at DESC)
`,
).catch((err) => {
  logger.error("user_sessions index migration error", { error: err.message });
});

function isHttpsRequest() {
  return process.env.BACKEND_URL?.startsWith("https");
}

function firstHeaderValue(value) {
  if (!value) return "";
  return String(value).split(",")[0].trim();
}

function getIpAddress(req) {
  return (
    firstHeaderValue(req.headers["x-forwarded-for"]) ||
    firstHeaderValue(req.headers["x-real-ip"]) ||
    req.ip ||
    "Unknown"
  );
}

function getLocationLabel(req) {
  const city = firstHeaderValue(req.headers["x-vercel-ip-city"]);
  const region = firstHeaderValue(req.headers["x-vercel-ip-country-region"]);
  const country =
    firstHeaderValue(req.headers["x-vercel-ip-country"]) ||
    firstHeaderValue(req.headers["cf-ipcountry"]) ||
    firstHeaderValue(req.headers["x-country-code"]);

  const parts = [city, region, country].filter(Boolean);
  if (parts.length === 0) return "Location unavailable";
  return parts.join(", ");
}

function detectBrowser(userAgent) {
  if (!userAgent) return "Unknown browser";
  if (/Edg\//i.test(userAgent)) return "Microsoft Edge";
  if (/OPR\//i.test(userAgent)) return "Opera";
  if (/Chrome\//i.test(userAgent)) return "Chrome";
  if (/Firefox\//i.test(userAgent)) return "Firefox";
  if (/Safari\//i.test(userAgent) && !/Chrome\//i.test(userAgent)) {
    return "Safari";
  }
  return "Unknown browser";
}

function detectOs(userAgent) {
  if (!userAgent) return "Unknown OS";
  if (/Windows NT/i.test(userAgent)) return "Windows";
  if (/Android/i.test(userAgent)) return "Android";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "iOS";
  if (/Mac OS X/i.test(userAgent)) return "macOS";
  if (/Linux/i.test(userAgent)) return "Linux";
  return "Unknown OS";
}

function detectDeviceType(userAgent) {
  if (!userAgent) return "Unknown device";
  if (/iPad|Tablet/i.test(userAgent)) return "Tablet";
  if (/Mobile|Android|iPhone|iPod/i.test(userAgent)) return "Mobile";
  return "Desktop";
}

function maskIpAddress(ipAddress) {
  if (!ipAddress || ipAddress === "Unknown") return "Unavailable";
  if (ipAddress.includes(":")) {
    const parts = ipAddress.split(":");
    return `${parts.slice(0, 3).join(":")}:****`;
  }
  const parts = ipAddress.split(".");
  if (parts.length !== 4) return ipAddress;
  return `${parts[0]}.${parts[1]}.${parts[2]}.***`;
}

export function getSessionMetadata(req) {
  const userAgent = String(req.headers["user-agent"] || "");
  return {
    browser: detectBrowser(userAgent),
    os: detectOs(userAgent),
    deviceType: detectDeviceType(userAgent),
    locationLabel: getLocationLabel(req),
    ipAddress: getIpAddress(req),
    userAgent,
  };
}

export function setAuthCookie(res, token) {
  const isHttps = isHttpsRequest();
  res.cookie("authToken", token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? "none" : "lax",
    maxAge: SESSION_TTL_MS,
  });
}

export function setPendingLoginCookie(res, token) {
  const isHttps = isHttpsRequest();
  res.cookie("loginOtp", token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? "none" : "lax",
    maxAge: PENDING_LOGIN_TTL_MS,
  });
}

export function clearPendingLoginCookie(res) {
  const isHttps = isHttpsRequest();
  res.clearCookie("loginOtp", {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? "none" : "lax",
  });
}

export function clearAuthCookie(res) {
  const isHttps = isHttpsRequest();
  res.clearCookie("authToken", {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? "none" : "lax",
  });
}

async function shouldSendAnomalyAlert(userId, sid, metadata) {
  const previousSessions = await db.query(
    `SELECT browser, os, device_type, location_label
       FROM user_sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND sid <> $2
      ORDER BY created_at DESC`,
    [userId, sid],
  );

  if (previousSessions.rows.length === 0) {
    return false;
  }

  return !previousSessions.rows.some(
    (row) =>
      row.browser === metadata.browser &&
      row.os === metadata.os &&
      row.device_type === metadata.deviceType &&
      row.location_label === metadata.locationLabel,
  );
}

async function sendAnomalyAlertEmail(user, metadata) {
  if (!process.env.SENDGRID_API_KEY?.startsWith("SG.") || !user?.email) {
    return;
  }

  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  const when = new Date().toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const html = emailWrap(
    `
      <h2 style="margin:0 0 12px;font-size:22px;color:#0f172a;">New sign-in detected</h2>
      <p style="margin:0 0 16px;color:#334155;line-height:1.7;">
        We noticed a sign-in to your Fonlok account from a device or location that does not match your recent sessions.
      </p>
      ${emailTable([
        ["Device", `${metadata.browser} on ${metadata.os}`],
        ["Type", metadata.deviceType],
        ["Location", metadata.locationLabel],
        ["Approx. IP", maskIpAddress(metadata.ipAddress)],
        ["Time", when],
      ])}
      <p style="margin:16px 0;color:#334155;line-height:1.7;">
        If this was you, no action is needed. If not, review your security settings immediately and revoke any unfamiliar sessions.
      </p>
      ${emailButton(`${frontendUrl}/settings`, "Review account security")}
    `,
    {
      subtitle: "Security alert",
      footerNote:
        "You received this email because a new sign-in was detected on your Fonlok account.",
    },
  );

  try {
    await sgMail.send({
      to: user.email,
      from: process.env.SENDGRID_FROM_EMAIL || process.env.SUPPORT_EMAIL,
      subject: "Fonlok security alert: new sign-in detected",
      html,
    });
  } catch (err) {
    logger.error("failed to send login anomaly alert", {
      userId: user.id,
      error: err.message,
    });
  }
}

export async function createUserSession(user, req, loginMethod = "password") {
  const sid = crypto.randomUUID();
  const metadata = getSessionMetadata(req);

  await db.query(
    `INSERT INTO user_sessions (
      sid, user_id, login_method, browser, os, device_type,
      location_label, ip_address, user_agent
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      sid,
      user.id,
      loginMethod,
      metadata.browser,
      metadata.os,
      metadata.deviceType,
      metadata.locationLabel,
      metadata.ipAddress,
      metadata.userAgent,
    ],
  );

  if (await shouldSendAnomalyAlert(user.id, sid, metadata)) {
    await sendAnomalyAlertEmail(user, metadata);
  }

  return { sid, metadata };
}

export async function issueUserAuthSession(res, user, req, loginMethod) {
  const { sid } = await createUserSession(user, req, loginMethod);
  const token = jwt.sign(
    {
      id: user.id,
      sid,
      normalizedEmail:
        user.normalizedemail || user.normalizedEmail || user.email || null,
    },
    process.env.JWT_SECRET,
    { expiresIn: "6h" },
  );

  setAuthCookie(res, token);
  return { token, sid };
}

export async function touchUserSession(sid, userId, req) {
  const metadata = getSessionMetadata(req);
  const result = await db.query(
    `UPDATE user_sessions
        SET last_active_at = NOW(),
            browser = COALESCE($3, browser),
            os = COALESCE($4, os),
            device_type = COALESCE($5, device_type),
            location_label = COALESCE($6, location_label),
            ip_address = COALESCE($7, ip_address),
            user_agent = COALESCE($8, user_agent)
      WHERE sid = $1 AND user_id = $2 AND revoked_at IS NULL
      RETURNING sid`,
    [
      sid,
      userId,
      metadata.browser,
      metadata.os,
      metadata.deviceType,
      metadata.locationLabel,
      metadata.ipAddress,
      metadata.userAgent,
    ],
  );
  return result.rows.length > 0;
}

export async function listUserSessions(userId, currentSid) {
  const result = await db.query(
    `SELECT sid, login_method, browser, os, device_type, location_label,
            ip_address, created_at, last_active_at
       FROM user_sessions
      WHERE user_id = $1 AND revoked_at IS NULL
      ORDER BY last_active_at DESC, created_at DESC`,
    [userId],
  );

  return result.rows.map((row) => ({
    sid: row.sid,
    loginMethod: row.login_method,
    browser: row.browser || "Unknown browser",
    os: row.os || "Unknown OS",
    deviceType: row.device_type || "Unknown device",
    location: row.location_label || "Location unavailable",
    ipAddress: maskIpAddress(row.ip_address),
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    isCurrent: currentSid ? row.sid === currentSid : false,
  }));
}

export async function revokeOtherUserSessions(userId, currentSid) {
  if (!currentSid) return 0;
  const result = await db.query(
    `UPDATE user_sessions
        SET revoked_at = NOW()
      WHERE user_id = $1 AND sid <> $2 AND revoked_at IS NULL`,
    [userId, currentSid],
  );
  return result.rowCount || 0;
}

export async function revokeUserSession(userId, sid) {
  const result = await db.query(
    `UPDATE user_sessions
        SET revoked_at = NOW()
      WHERE user_id = $1 AND sid = $2 AND revoked_at IS NULL
      RETURNING sid`,
    [userId, sid],
  );
  return result.rows.length > 0;
}
