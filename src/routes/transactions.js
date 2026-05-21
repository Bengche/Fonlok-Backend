import express from "express";
const router = express.Router();
import db from "../controllers/db.js";
import dotenv from "dotenv";
import { generateStatementPdf } from "../utils/generateReceipt.js";
import authMiddleware from "../middleware/authMiddleware.js";
dotenv.config();

// GET /transactions/history/:userid
// Returns all transactions for a user:
//   - As a SELLER: payouts made to them (money they received)
//   - As a BUYER: payments they made (money they spent)
router.get("/history/:userid", async (req, res) => {
  const userId = req.params.userid;

  try {
    // 1. Get all payouts received as a seller.
    //    LEFT JOIN invoices on invoice_number so we can surface the real
    //    invoice name, invoice number, and gross amount alongside the net payout.
    const sellerTransactions = await db.query(
      `SELECT DISTINCT ON (payouts.id)
        payouts.id,
        'payout' AS transaction_type,
        payouts.amount,
        payouts.status,
        payouts.createdat,
        COALESCE(invoices.invoicename, 'Payout') AS invoicename,
        COALESCE(payouts.invoice_number, '') AS invoicenumber,
        'XAF' AS currency,
        invoices.amount AS gross_amount
       FROM payouts
       LEFT JOIN invoices ON invoices.invoicenumber = payouts.invoice_number
       WHERE payouts.userid = $1
       ORDER BY payouts.id, payouts.createdat DESC`,
      [userId],
    );

    // 2. Get all payments made as a buyer.
    //    Use DISTINCT ON (payments.id) to avoid fan-out from multiple
    //    guests rows that can share the same invoice number.
    const buyerTransactions = await db.query(
      `SELECT DISTINCT ON (payments.id)
        payments.id,
        'payment' AS transaction_type,
        payments.amount,
        payments.status,
        payments.createdat,
        invoices.invoicename,
        invoices.invoicenumber,
        invoices.currency,
        invoices.amount AS gross_amount
       FROM payments
       JOIN invoices ON invoices.id = payments.invoiceid
       JOIN guests ON guests.invoicenumber = invoices.invoicenumber
       WHERE guests.registered_userid = $1
       ORDER BY payments.id, payments.createdat DESC`,
      [userId],
    );

    return res.status(200).json({
      sellerTransactions: sellerTransactions.rows,
      buyerTransactions: buyerTransactions.rows,
    });
  } catch (error) {
    console.log(error.message);
    return res.status(500).json({
      message: "Failed to load transaction history. Please try again.",
    });
  }
});

// GET /transactions/statement
// Download a PDF statement in a date range, or full history when no dates are provided.
// Query params (optional): start_date (ISO string), end_date (ISO string)
router.get("/statement", authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.user_id;
    const { start_date, end_date, lang } = req.query;

    if (!userId) {
      return res.status(401).json({
        message: "Unauthorized. Please sign in.",
      });
    }

    let startDate;
    let endDate;

    if (start_date) {
      startDate = new Date(start_date);
      if (isNaN(startDate.getTime())) {
        return res.status(400).json({
          message: "Invalid start_date format. Use ISO format (YYYY-MM-DD).",
        });
      }
    } else {
      startDate = new Date("1970-01-01T00:00:00.000Z");
    }

    if (end_date) {
      endDate = new Date(end_date);
      if (isNaN(endDate.getTime())) {
        return res.status(400).json({
          message: "Invalid end_date format. Use ISO format (YYYY-MM-DD).",
        });
      }
    } else {
      endDate = new Date();
    }

    if (startDate > endDate) {
      return res.status(400).json({
        message: "start_date must be before end_date.",
      });
    }

    const pdfBuffer = await generateStatementPdf(
      userId,
      startDate,
      endDate,
      lang,
    );

    const fileName =
      start_date || end_date
        ? `fonlok-statement-${startDate.toISOString().split("T")[0]}-${endDate.toISOString().split("T")[0]}.pdf`
        : "fonlok-statement-full.pdf";

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error("Failed to generate statement:", error.message);
    return res.status(500).json({
      message: "Failed to generate statement. Please try again.",
    });
  }
});

export default router;
