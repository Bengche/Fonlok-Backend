import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

// This middleware protects all admin routes.
// It looks for a cookie called 'adminToken', verifies it, and checks that
// the payload contains { isAdmin: true }. If anything is wrong it rejects the request.
const adminMiddleware = (req, res, next) => {
  const token = req.cookies.adminToken;

  if (!token) {
    return res
      .status(401)
      .json({ message: "Admin access required. Please log in." });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded.isAdmin) {
      return res
        .status(403)
        .json({ message: "Forbidden. You are not an admin." });
    }

    req.admin = decoded;
    next();
  } catch {
    return res
      .status(401)
      .json({
        message: "Invalid or expired admin session. Please log in again.",
      });
  }
};

export default adminMiddleware;
