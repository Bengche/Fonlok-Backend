/**
 * platformGuard.js
 *
 * Express middleware to enforce platform-wide operational flags stored in the
 * platform_settings table.  Three guards are exported:
 *
 *   maintenanceGuard  — blocks all non-admin traffic when maintenance_mode is on
 *   paymentsGuard     — blocks incoming payment initiations when payments_blocked
 *   payoutsGuard      — blocks payout releases when payouts_blocked
 *
 * Each returns HTTP 503 with a JSON body that the frontend can detect and
 * surface as a user-friendly banner rather than a generic error.
 */

import { getSettings, bool } from "../utils/platformSettings.js";

export async function maintenanceGuard(req, res, next) {
  try {
    const s = await getSettings();
    if (bool(s, "maintenance_mode")) {
      return res.status(503).json({
        maintenanceMode: true,
        message:
          "The platform is currently under scheduled maintenance. Please check back shortly.",
      });
    }
  } catch (_err) {
    // If we cannot read settings, fail open (don't block legitimate traffic).
  }
  next();
}

export async function paymentsGuard(req, res, next) {
  try {
    const s = await getSettings();
    if (bool(s, "payments_blocked")) {
      return res.status(503).json({
        paymentsBlocked: true,
        message:
          "Payments are temporarily suspended by the platform administrator. Please try again later.",
      });
    }
  } catch (_err) {
    // Fail open.
  }
  next();
}

export async function payoutsGuard(req, res, next) {
  try {
    const s = await getSettings();
    if (bool(s, "payouts_blocked")) {
      return res.status(503).json({
        payoutsBlocked: true,
        message:
          "Payouts are temporarily suspended by the platform administrator. Please try again later.",
      });
    }
  } catch (_err) {
    // Fail open.
  }
  next();
}
