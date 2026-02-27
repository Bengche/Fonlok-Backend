/**
 * cloudinary.js — Cloudinary SDK initialisation + upload helpers
 *
 * All media (profile pictures, chat attachments) is stored in Cloudinary.
 * The database only stores the secure_url returned by Cloudinary.
 *
 * Folders used:
 *   fonlok/avatars   — profile pictures
 *   fonlok/chat      — chat image/PDF attachments
 */

import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a Buffer to Cloudinary.
 *
 * @param {Buffer} buffer        - File buffer (from multer memoryStorage)
 * @param {object} options       - Cloudinary upload_stream options
 *   e.g. { folder: "fonlok/avatars", resource_type: "image" }
 * @returns {Promise<{ url: string, publicId: string }>}
 */
export function uploadToCloudinary(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      options,
      (error, result) => {
        if (error) return reject(error);
        resolve({ url: result.secure_url, publicId: result.public_id });
      },
    );
    stream.end(buffer);
  });
}

/**
 * Delete a file from Cloudinary by its public_id.
 * Non-fatal — warns on failure rather than throwing.
 *
 * @param {string} publicId   - Cloudinary public_id (not the full URL)
 * @param {object} options    - e.g. { resource_type: "raw" } for PDFs
 */
export async function deleteFromCloudinary(publicId, options = {}) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, options);
  } catch (err) {
    console.warn("⚠️  Could not delete from Cloudinary:", err.message);
  }
}

/**
 * Extract the Cloudinary public_id from a full secure_url.
 *
 * e.g. "https://res.cloudinary.com/mycloud/image/upload/v123/fonlok/avatars/abc.jpg"
 *   → "fonlok/avatars/abc"
 *
 * Returns null if the URL doesn't look like a Cloudinary URL.
 */
export function publicIdFromUrl(url) {
  if (!url || !url.includes("res.cloudinary.com")) return null;
  try {
    // Pattern: .../upload/v<version>/<public_id>.<ext>  OR  .../upload/<public_id>.<ext>
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+)$/);
    if (!match) return null;
    // Strip the file extension
    return match[1].replace(/\.[^/.]+$/, "");
  } catch {
    return null;
  }
}

export default cloudinary;
