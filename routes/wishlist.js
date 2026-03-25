import express from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../config/database.js";
import { authenticateToken } from "../middleware/auth.js";

const router = express.Router()

// Get user's wishlist
router.get("/", authenticateToken, async (req, res) => {
  try {
    // const [wishlistItems] = await db.execute(
    //   `SELECT 
    //     w.id, w.user_id, w.product_id, w.created_at,
    //     p.name, p.price, p.image_url, p.availability
    //    FROM wishlist w
    //    JOIN products p ON w.product_id = p.id
    //    WHERE w.user_id = ?
    //    ORDER BY w.created_at DESC`,
    //   [req.user.id],
    // )
        const [wishlistItems] = await db.execute(
      `SELECT 
        p.*,
        c.name as category_name,
        c.name_ar as category_name_ar,
        b.name as brand_name,
        b.name_ar as brand_name_ar
       FROM wishlist AS w
       JOIN products AS p ON w.product_id = p.id
       LEFT JOIN categories AS c ON p.category_id = c.id
       LEFT JOIN brands AS b ON p.brand_id = b.id
       WHERE w.user_id = ?
       ORDER BY w.created_at DESC`,
      [req.user.id],
    );

//     const formattedItems = wishlistItems.map((item) => ({
//       id: item.id,
//       user_id: item.user_id,
//       product_id: item.product_id,
//       created_at: item.created_at,
//       product: {
//         id: item.product_id,
//         name: item.name,
//         price: item.price,
//         image_url: item.image_url,
//         availability: item.availability,
//       },
//     }))

//     res.json(formattedItems)
//   } catch (error) {
//     console.error("Get wishlist error:", error)
//     res.status(500).json({ error: "Failed to fetch wishlist" })
//   }
// })

    const formattedItems = wishlistItems.map((item) => {
      // The product object is now the primary object we return for each item
      const product = { ...item };
      
      // Re-structure category and brand into nested objects as the frontend expects
      product.category = {
        id: item.category_id,
        name: item.category_name,
        name_ar: item.category_name_ar
      };
      product.brand = {
        id: item.brand_id,
        name: item.brand_name,
        name_ar: item.brand_name_ar
      };

      // Clean up redundant fields
      delete product.category_name;
      delete product.category_name_ar;
      delete product.brand_name;
      delete product.brand_name_ar;

      return product;
    });

    res.json(formattedItems);
  } catch (error) {
    console.error("Get wishlist error:", error);
    res.status(500).json({ error: "Failed to fetch wishlist" });
  }
});

// Add item to wishlist
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { productId } = req.body

    if (!productId) {
      return res.status(400).json({ error: "Product ID is required" })
    }

    // Check if product exists
    const [products] = await db.execute("SELECT id FROM products WHERE id = ?", [productId])
    if (products.length === 0) {
      return res.status(404).json({ error: "Product not found" })
    }

    // Check if item already in wishlist
    const [existing] = await db.execute("SELECT id FROM wishlist WHERE user_id = ? AND product_id = ?", [
      req.user.id,
      productId,
    ])

    if (existing.length > 0) {
      return res.status(400).json({ error: "Item already in wishlist" })
    }

    // Add to wishlist
    const wishlistId = uuidv4()
    await db.execute("INSERT INTO wishlist (id, user_id, product_id) VALUES (?, ?, ?)", [
      wishlistId,
      req.user.id,
      productId,
    ])

    res.status(201).json({
      message: "Item added to wishlist successfully",
      wishlistId,
    })
  } catch (error) {
    console.error("Add to wishlist error:", error)
    res.status(500).json({ error: "Failed to add item to wishlist" })
  }
})

// Remove item from wishlist
router.delete("/:productId", authenticateToken, async (req, res) => {
  try {
    const [result] = await db.execute("DELETE FROM wishlist WHERE user_id = ? AND product_id = ?", [
      req.user.id,
      req.params.productId,
    ])

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Item not found in wishlist" })
    }

    res.json({ message: "Item removed from wishlist successfully" })
  } catch (error) {
    console.error("Remove from wishlist error:", error)
    res.status(500).json({ error: "Failed to remove item from wishlist" })
  }
})

export default router;