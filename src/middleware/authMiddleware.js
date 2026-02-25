import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

const authMiddleware = (req, res, next) => {
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
