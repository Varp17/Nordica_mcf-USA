// backend/routes/public.js
import express from "express";
import db from "../config/database.js";

const router = express.Router();

/**
 * PUBLIC: active homepage banners
 * GET /api/public/banners
 */
router.get("/banners", async (req, res) => {
  try {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const [rows] = await db.execute(
      `
      SELECT id, title, subtitle, image_url, link, position
      FROM banners
      WHERE is_active = 1
        AND (valid_from IS NULL OR valid_from <= ?)
        AND (valid_to IS NULL OR valid_to >= ?)
      ORDER BY position ASC, created_at DESC
      `,
      [now, now]
    );
    res.json({ banners: rows });
  } catch (error) {
    console.error("Public banners error:", error);
    res.status(500).json({ error: "Failed to fetch banners" });
  }
});

export default router;
