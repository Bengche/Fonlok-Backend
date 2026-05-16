import db from "../controllers/db.js";

export function normalizeEmailLanguage(language) {
  return String(language || "en").toLowerCase().startsWith("fr") ? "fr" : "en";
}

export async function getUserEmailLanguageById(userId) {
  const result = await db.query(
    "SELECT preferred_email_language FROM users WHERE id = $1",
    [userId],
  );
  if (result.rows.length === 0) return "en";
  return normalizeEmailLanguage(result.rows[0].preferred_email_language);
}

export async function getUserEmailLanguageByEmail(email) {
  const result = await db.query(
    "SELECT preferred_email_language FROM users WHERE LOWER(email) = LOWER($1)",
    [email],
  );
  if (result.rows.length === 0) return "en";
  return normalizeEmailLanguage(result.rows[0].preferred_email_language);
}
