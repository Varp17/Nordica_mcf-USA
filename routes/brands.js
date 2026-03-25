import express from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../config/database.js";
import { authenticateToken, requireAdmin } from "../middleware/auth.js";

const router = express.Router()

// Get all brands
router.get("/", async (req, res) => {
  try {
    const [brands] = await db.execute(
      "SELECT id, name, name_ar, description, description_ar, logo_url, website FROM brands ORDER BY name",
    )

    res.json(brands)
  } catch (error) {
    console.error("Get brands error:", error)
    res.status(500).json({ error: "Failed to fetch brands" })
  }
})

// Create brand (Admin only)
router.post("/", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, nameAr, description, descriptionAr, logoUrl, website } = req.body

    if (!name) {
      return res.status(400).json({ error: "Brand name is required" })
    }

    const brandId = uuidv4()
    await db.execute(
      "INSERT INTO brands (id, name, name_ar, description, description_ar, logo_url, website) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [brandId, name, nameAr || null, description || null, descriptionAr || null, logoUrl || null, website || null],
    )

    res.status(201).json({
      message: "Brand created successfully",
      brandId,
    })
  } catch (error) {
    console.error("Create brand error:", error)
    res.status(500).json({ error: "Failed to create brand" })
  }
})

export default router;