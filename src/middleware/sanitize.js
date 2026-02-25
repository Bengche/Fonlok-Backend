/**
 * sanitize.js — Input sanitization middleware
 *
 * Strips XSS payloads from every string field in req.body before the route
 * handler runs.  Uses the `xss` library which allows safe HTML through a
 * whitelist — here we pass an empty whitelist to strip ALL HTML tags and
 * attributes, since our API never intentionally receives raw HTML.
 *
 * Handles nested objects and arrays (e.g. milestone arrays on invoices).
 */

import xss from "xss";

// XSS options: strip all tags — no whitelist, no allowed attributes
const xssOptions = {
  whiteList: {}, // no tags allowed
  stripIgnoreTag: true, // strip unrecognised tags entirely
  stripIgnoreTagBody: ["script", "style"], // also remove tag body for these
};

/**
 * Recursively sanitize every string value in an object / array.
 * Numbers, booleans, and null are returned as-is.
 */
function sanitizeValue(value) {
  if (typeof value === "string") {
    return xss(value, xssOptions);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value !== null && typeof value === "object") {
    const sanitized = {};
    for (const [k, v] of Object.entries(value)) {
      sanitized[k] = sanitizeValue(v);
    }
    return sanitized;
  }
  return value;
}

/**
 * Express middleware — mutates req.body in place.
 * Attach after express.json() / express.urlencoded() in server.js.
 */
export function sanitizeBody(req, _res, next) {
  if (req.body && typeof req.body === "object") {
    req.body = sanitizeValue(req.body);
  }
  next();
}
