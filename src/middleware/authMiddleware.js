import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import db from "../controllers/db.js";
import { clearAuthCookie, touchUserSession } from "../utils/sessionSecurity.js";
dotenv.config();

const authMiddleware = async (req, res, next) => {
  // Accept token from httpOnly cookie (preferred) OR Authorization header
  // (fallback for cases where secure cookies can't be sent over plain HTTP).
  let token = req.cookies.authToken || req.cookies.token;
  if (!token) {
    const authHeader =
      req.headers["authorization"] || req.headers["Authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const candidate = authHeader.slice(7);
      if (candidate && candidate !== "undefined" && candidate !== "null") {
        token = candidate;
      }
    }
  }

  if (!token)
    return res
      .status(401)
      .json({ message: "Unauthorized. Please sign in.", code: "NO_TOKEN" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded?.sid) {
      const stillActive = await touchUserSession(decoded.sid, decoded.id, req);
      if (!stillActive) {
        clearAuthCookie(res);
        return res.status(401).json({
          message: "This session has been revoked. Please sign in again.",
          code: "SESSION_REVOKED",
        });
      }
    }
    req.user = decoded;

    // ── Suspension check ────────────────────────────────────────────────────
    // Runs on every authenticated request. Exempt routes: /appeal, /suspension-status.
    // These exemptions let suspended users view their status and submit an appeal.
    try {
      const suspRow = await db.query(
        `SELECT is_suspended, suspended_until, suspension_reason, appeal_status
         FROM users WHERE id = $1`,
        [decoded.id],
      );
      if (suspRow.rows.length) {
        const s = suspRow.rows[0];
        const isActive =
          s.is_suspended &&
          (s.suspended_until === null ||
            new Date(s.suspended_until) > new Date());
        if (isActive) {
          req.user.is_suspended = true;
          req.user.suspended_until = s.suspended_until;
          req.user.suspension_reason = s.suspension_reason;
          req.user.appeal_status = s.appeal_status;
          const exempted = ["/appeal", "/suspension-status"];
          const isExempt = exempted.some((p) => req.path === p || req.path.startsWith(p + "?"));
          if (!isExempt) {
            return res.status(403).json({
              code: "ACCOUNT_SUSPENDED",
              message: "Your account has been suspended. You cannot perform this action.",
              suspension_reason: s.suspension_reason,
              suspended_until: s.suspended_until,
              appeal_status: s.appeal_status,
            });
          }
        }
      }
    } catch {
      /* non-fatal — don't block auth if suspension check fails */
    }

    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        message: "Your session has expired. Please sign in again.",
        code: "TOKEN_EXPIRED",
      });
    }
    return res.status(401).json({
      message: "Invalid session. Please sign in again.",
      code: "INVALID_TOKEN",
    });
  }
};

export default authMiddleware;
