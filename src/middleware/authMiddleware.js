import jwt from "jsonwebtoken";
import dotenv from "dotenv";
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
