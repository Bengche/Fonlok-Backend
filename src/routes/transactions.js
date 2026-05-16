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
    // 1. Get all payouts received as a seller
    //    payouts are not linked to a specific invoice in the schema,
    //    so we return them directly without a JOIN to avoid a cartesian product.
    const sellerTransactions = await db.query(
      `SELECT 
        id,
        'payout' AS transaction_type,
        amount,
        status,
        createdat,
        'Payout received' AS invoicename,
        '' AS invoicenumber,
        'XAF' AS currency
       FROM payouts
       WHERE userid = $1
       ORDER BY createdat DESC`,
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
        invoices.currency
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
// Download a PDF statement of all transactions in a date range
// Query params: start_date (ISO string), end_date (ISO string)
router.get("/statement", authMiddleware, async (req, res) => {
  try {
    const userId = req.user_id;
    const { start_date, end_date, lang } = req.query;

    if (!start_date || !end_date) {
      return res.status(400).json({
        message: "start_date and end_date query parameters are required",
      });
    }

    const startDate = new Date(start_date);
    const endDate = new Date(end_date);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).json({
        message: "Invalid date format. Use ISO format (YYYY-MM-DD).",
      });
    }

    const pdfBuffer = await generateStatementPdf(
      userId,
      startDate,
      endDate,
      lang,
    );

    const fileName = `fonlok-statement-${startDate.toISOString().split("T")[0]}-${endDate.toISOString().split("T")[0]}.pdf`;

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
