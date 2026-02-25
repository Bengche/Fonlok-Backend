/**
 * validate.js — Shared input validation helper
 *
 * How to use:
 *   1. Import `body` from "express-validator" in your route file
 *   2. Import `validate` from "../middleware/validate.js"
 *   3. Add an array of `body(...)` chains + `validate` as route middleware
 *
 * Example:
 *   router.post("/register",
 *     [body("email").isEmail().withMessage("Valid email required"), ...],
 *     validate,
 *     async (req, res) => { ... }
 *   );
 */

import { validationResult } from "express-validator";

/**
 * validate — Reads the errors collected by express-validator and returns
 * a 400 response with the FIRST error message if anything is wrong.
 * If everything is fine, it calls next() to continue to your route handler.
 */
export const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Return only the first error to keep responses clean and simple
    return res.status(400).json({ message: errors.array()[0].msg });
  }
  next();
};
