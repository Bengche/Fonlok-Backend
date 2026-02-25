import express from "express";
const router = express.Router();
import db from "../controllers/db.js";
import authMiddleware from "../middleware/authMiddleware.js";
import dotenv from "dotenv";
dotenv.config();

// GET /templates/:userid
// Returns all saved invoice templates for a user
router.get("/:userid", async (req, res) => {
  const { userid } = req.params;

  try {
    const result = await db.query(
      "SELECT * FROM invoice_templates WHERE userid = $1 ORDER BY created_at DESC",
      [userid],
    );
    return res.status(200).json({ templates: result.rows });
  } catch (error) {
    console.log(error.message);
    return res
      .status(500)
      .json({ message: "Failed to load templates. Please try again." });
  }
});

// POST /templates/save
// Saves a new invoice template for the logged-in user
router.post("/save", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { template_name, invoicename, currency, amount, description } =
    req.body;

  try {
    // Make sure the template name is not empty
    if (!template_name || template_name.trim() === "") {
      return res
        .status(400)
        .json({ message: "Please provide a name for this template." });
    }

    const result = await db.query(
      `INSERT INTO invoice_templates (userid, template_name, invoicename, currency, amount, description)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userId, template_name, invoicename, currency, amount, description],
    );

    return res.status(201).json({
      message: "Template saved successfully.",
      template: result.rows[0],
    });
  } catch (error) {
    console.log(error.message);
    return res
      .status(500)
      .json({ message: "Failed to save template. Please try again." });
  }
});

// DELETE /templates/:id
// Deletes a saved template
router.delete("/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    // Make sure the template belongs to the logged-in user before deleting
    const check = await db.query(
      "SELECT * FROM invoice_templates WHERE id = $1 AND userid = $2",
      [id, userId],
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ message: "Template not found." });
    }

    await db.query("DELETE FROM invoice_templates WHERE id = $1", [id]);

    return res.status(200).json({ message: "Template deleted." });
  } catch (error) {
    console.log(error.message);
    return res
      .status(500)
      .json({ message: "Failed to delete template. Please try again." });
  }
});

export default router;
