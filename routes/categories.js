import express from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../config/database.js";
import { authenticateToken, requireAdmin } from "../middleware/auth.js";

const router = express.Router()

// Get all categories
router.get("/", async (req, res) => {
  try {
    const [categories] = await db.execute(
      "SELECT id, name, name_ar, description, description_ar, image_url FROM categories ORDER BY name",
    )

    res.json(categories)
  } catch (error) {
    console.error("Get categories error:", error)
    res.status(500).json({ error: "Failed to fetch categories" })
  }
})

// Create category (Admin only)
router.post("/", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, nameAr, description, descriptionAr, imageUrl } = req.body

    if (!name) {
      return res.status(400).json({ error: "Category name is required" })
    }

    const categoryId = uuidv4()
    await db.execute(
      "INSERT INTO categories (id, name, name_ar, description, description_ar, image_url) VALUES (?, ?, ?, ?, ?, ?)",
      [categoryId, name, nameAr || null, description || null, descriptionAr || null, imageUrl || null],
    )

    res.status(201).json({
      message: "Category created successfully",
      categoryId,
    })
  } catch (error) {
    console.error("Create category error:", error)
    res.status(500).json({ error: "Failed to create category" })
  }
})

export default router;