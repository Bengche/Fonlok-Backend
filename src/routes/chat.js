import express from "express";
const router = express.Router();
import db from "../controllers/db.js";
import dotenv from "dotenv";
import multer from "multer";
import authMiddleware from "../middleware/authMiddleware.js";
import { body } from "express-validator";
import { validate } from "../middleware/validate.js";
import { notifyUser } from "../middleware/notificationHelper.js";
import sgMail from "@sendgrid/mail";
import { emailWrap, emailButton } from "../utils/emailTemplate.js";
import { uploadToCloudinary } from "../utils/cloudinary.js";
dotenv.config();
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ── Notify the buyer by email when the seller sends a message ────────────────
// To avoid flooding, we skip the email if a seller message was already sent
// in this chat within the last 10 minutes (i.e. the buyer was already alerted).
async function notifyBuyerByEmail(invoicenumber, chatId) {
  try {
    // Flood guard: any seller message in the last 10 min means buyer was already notified
    const recent = await db.query(
      `SELECT 1 FROM messages
       WHERE chat_id = $1
         AND sender_type = 'seller'
         AND created_at > NOW() - INTERVAL '10 minutes'
       LIMIT 2`,
      [chatId],
    );
    // rows.length will be at least 1 (the message we just inserted);
    // if it's > 1 a notification was already sent recently — skip.
    if (recent.rows.length > 1) return;

    // Look up buyer email + chat token from guests
    const guestResult = await db.query(
      "SELECT email, chat_token FROM guests WHERE invoicenumber = $1 ORDER BY created_at DESC LIMIT 1",
      [invoicenumber],
    );
    if (guestResult.rows.length === 0 || !guestResult.rows[0].email) return;

    const { email: buyerEmail, chat_token } = guestResult.rows[0];
    if (!chat_token) return; // chat not yet set up

    const chatLink = `${process.env.FRONTEND_URL}/chat/${invoicenumber}?token=${chat_token}`;

    const msg = {
      to: buyerEmail,
      from: process.env.VERIFIED_SENDER,
      subject: `New message from the seller – Invoice ${invoicenumber} | Fonlok`,
      html: emailWrap(
        `<h2 style="color:#0F1F3D;margin:0 0 12px;">The seller replied to you</h2>
        <p style="color:#475569;">The seller has sent you a new message regarding invoice <strong>${invoicenumber}</strong>. Click below to view and reply.</p>
        ${emailButton(chatLink, "Open Chat")}
        <p style="color:#94a3b8;font-size:13px;margin-top:16px;">You will only receive one reminder per 10 minutes to avoid inbox clutter.</p>`,
        {
          footerNote:
            "You received this because you are the buyer on a Fonlok escrow transaction. Keep your chat link private.",
        },
      ),
    };

    await sgMail.send(msg);
    console.log(
      `✅  Buyer reply-notification sent to ${buyerEmail} for invoice ${invoicenumber}`,
    );
  } catch (err) {
    // Non-fatal — message was saved, notification is best-effort
    console.error("⚠️  Could not send buyer reply notification:", err.message);
  }
}

// --- MULTER SETUP (memory storage — buffer goes to Cloudinary, not disk) ---
// Only allow images and PDFs — explicitly block HTML, SVG, JS and any other
// file type that a browser would execute or render as markup, which would
// enable stored XSS attacks served from our own domain.
const CHAT_ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max per chat attachment
  fileFilter: (req, file, cb) => {
    if (CHAT_ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new multer.MulterError(
          "LIMIT_UNEXPECTED_FILE",
          "Only images (JPEG, PNG, WebP, GIF) and PDFs are allowed in chat.",
        ),
      );
    }
  },
});
  fileFilter: (req, file, cb) => {
    if (CHAT_ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new multer.MulterError(
          "LIMIT_UNEXPECTED_FILE",
          "Only images (JPEG, PNG, WebP, GIF) and PDFs are allowed in chat.",
        ),
      );
    }
  },
});

// --- HELPER: Verify that a buyer's token matches the invoice ---
const verifyBuyerToken = async (invoicenumber, token) => {
  const result = await db.query(
    "SELECT * FROM guests WHERE invoicenumber = $1 AND chat_token = $2",
    [invoicenumber, token],
  );
  return result.rows[0] || null; // returns the guest row if token is valid, or null
};

// --- ROUTE 1: GET all messages for a chat ---
// Seller calls this with their auth cookie (they are logged in)
// Buyer calls this with ?token=their_chat_token in the URL
router.get("/messages/:invoicenumber", async (req, res) => {
  const { invoicenumber } = req.params;
  const { token } = req.query;

  try {
    // Find the chat room for this invoice
    const chatResult = await db.query(
      "SELECT * FROM chats WHERE invoicenumber = $1",
      [invoicenumber],
    );
    if (chatResult.rows.length === 0) {
      return res
        .status(404)
        .json({ message: "Chat room not found for this invoice." });
    }

    const chat = chatResult.rows[0];

    // Check who is requesting:
    // If a token is provided, it's the buyer
    if (token) {
      const guest = await verifyBuyerToken(invoicenumber, token);
      if (!guest) {
        return res
          .status(401)
          .json({ message: "Invalid token. Access denied." });
      }
    }
    // If no token, we trust it's the seller (they are authenticated on the frontend)
    // You can add authMiddleware here later if you want stricter seller verification

    // Fetch all messages for this chat, ordered oldest first
    const messagesResult = await db.query(
      "SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC",
      [chat.id],
    );

    return res
      .status(200)
      .json({ messages: messagesResult.rows, chat_id: chat.id });
  } catch (error) {
    console.log(error.message);
    return res.status(500).json({ message: "Something went wrong." });
  }
});

// --- ROUTE 2: Send a text message ---
// seller sends: { message, sender_type: "seller" }
// buyer sends:  { message, sender_type: "buyer", token: "their_chat_token" }
router.post(
  "/send/:invoicenumber",
  [
    body("message")
      .trim()
      .notEmpty()
      .withMessage("Message cannot be empty.")
      .isLength({ max: 2000 })
      .withMessage("Message must be 2000 characters or fewer.")
      .escape(),

    body("sender_type")
      .trim()
      .isIn(["seller", "buyer"])
      .withMessage("Sender type must be 'seller' or 'buyer'."),

    body("token").optional({ checkFalsy: true }).trim(),
  ],
  validate,
  async (req, res) => {
    const { invoicenumber } = req.params;
    const { message, sender_type, token } = req.body;

    try {
      // Find the chat room
      const chatResult = await db.query(
        "SELECT * FROM chats WHERE invoicenumber = $1",
        [invoicenumber],
      );
      if (chatResult.rows.length === 0) {
        return res
          .status(404)
          .json({ message: "Chat room not found for this invoice." });
      }

      const chat = chatResult.rows[0];
      let sender_email = "";

      // Verify who is sending
      if (sender_type === "buyer") {
        const guest = await verifyBuyerToken(invoicenumber, token);
        if (!guest) {
          return res
            .status(401)
            .json({ message: "Invalid token. Access denied." });
        }
        sender_email = guest.email;
      } else if (sender_type === "seller") {
        // Get seller email from invoices -> users
        const invoiceResult = await db.query(
          "SELECT users.email FROM invoices JOIN users ON invoices.userid = users.id WHERE invoices.invoicenumber = $1",
          [invoicenumber],
        );
        if (invoiceResult.rows.length > 0) {
          sender_email = invoiceResult.rows[0].email;
        }
      }

      // Save the message to the database
      const newMessage = await db.query(
        "INSERT INTO messages (chat_id, sender_type, sender_email, message) VALUES ($1, $2, $3, $4) RETURNING *",
        [chat.id, sender_type, sender_email, message],
      );

      // Notify the seller when a buyer sends a message
      if (sender_type === "buyer") {
        const invoiceOwner = await db.query(
          "SELECT userid FROM invoices WHERE invoicenumber = $1",
          [invoicenumber],
        );
        if (invoiceOwner.rows.length > 0) {
          notifyUser(
            invoiceOwner.rows[0].userid,
            "new_message",
            "New Message 💬",
            `You have a new message from the buyer on invoice ${invoicenumber}.`,
            { invoiceNumber: invoicenumber },
          );
        }
      }

      // Notify the buyer by email when the seller sends a message
      if (sender_type === "seller") {
        await notifyBuyerByEmail(invoicenumber, chat.id);
      }

      return res.status(200).json({ message: newMessage.rows[0] });
    } catch (error) {
      console.log(error.message);
      return res.status(500).json({ message: "Something went wrong." });
    }
  },
);

// --- ROUTE 3: Upload a file (proof of product, screenshots, etc.) ---
// seller sends: form-data with file + sender_type: "seller"
// buyer sends:  form-data with file + sender_type: "buyer" + token: "their_chat_token"
router.post(
  "/upload/:invoicenumber",
  upload.single("file"),
  async (req, res) => {
    const { invoicenumber } = req.params;
    const { sender_type, token } = req.body;

    try {
      // Find the chat room
      const chatResult = await db.query(
        "SELECT * FROM chats WHERE invoicenumber = $1",
        [invoicenumber],
      );
      if (chatResult.rows.length === 0) {
        return res.status(404).json({ message: "Chat room not found." });
      }

      const chat = chatResult.rows[0];
      let sender_email = "";

      // Verify who is uploading
      if (sender_type === "buyer") {
        const guest = await verifyBuyerToken(invoicenumber, token);
        if (!guest) {
          return res
            .status(401)
            .json({ message: "Invalid token. Access denied." });
        }
        sender_email = guest.email;
      } else if (sender_type === "seller") {
        const invoiceResult = await db.query(
          "SELECT users.email FROM invoices JOIN users ON invoices.userid = users.id WHERE invoices.invoicenumber = $1",
          [invoicenumber],
        );
        if (invoiceResult.rows.length > 0) {
          sender_email = invoiceResult.rows[0].email;
        }
      }

      // Upload file to Cloudinary
      // PDFs must use resource_type "raw"; images use "image"
      const isPdf = req.file.mimetype === "application/pdf";
      const { url: fileUrl } = await uploadToCloudinary(req.file.buffer, {
        folder: "fonlok/chat",
        resource_type: isPdf ? "raw" : "image",
        // Unique public_id: chat_<chatId>_<timestamp>
        public_id: `chat_${chat.id}_${Date.now()}`,
      });

      // Save the file message to the database
      const newMessage = await db.query(
        "INSERT INTO messages (chat_id, sender_type, sender_email, file_url) VALUES ($1, $2, $3, $4) RETURNING *",
        [chat.id, sender_type, sender_email, fileUrl],
      );

      // Notify seller (bell) when buyer uploads; notify buyer (email) when seller uploads
      if (sender_type === "buyer") {
        const invoiceOwner = await db.query(
          "SELECT userid FROM invoices WHERE invoicenumber = $1",
          [invoicenumber],
        );
        if (invoiceOwner.rows.length > 0) {
          notifyUser(
            invoiceOwner.rows[0].userid,
            "new_message",
            "New File 📎",
            `The buyer uploaded a file on invoice ${invoicenumber}.`,
            { invoiceNumber: invoicenumber },
          );
        }
      } else if (sender_type === "seller") {
        await notifyBuyerByEmail(invoicenumber, chat.id);
      }

      return res.status(200).json({ message: newMessage.rows[0] });
    } catch (error) {
      console.log(error.message);
      return res.status(500).json({ message: "Something went wrong." });
    }
  },
);

export default router;
