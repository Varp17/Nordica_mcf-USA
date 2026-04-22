import express from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../config/database.js";
import { optionalAuth } from "../middleware/auth.js";

const router = express.Router()

// Get user's or guest's wishlist
router.get("/", optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const guestId = req.headers['x-guest-id'] || req.query.guest_id;

    if (!userId && !guestId) {
      return res.json([]); // Return empty for unknown guests
    }

    const [wishlistItems] = await db.execute(
      `SELECT 
        p.*,
        c.name as category_name,
        c.name_ar as category_name_ar,
        b.name as brand_name,
        b.name_ar as brand_name_ar
       FROM wishlists AS w
       JOIN products AS p ON w.product_id = p.id
       LEFT JOIN categories AS c ON p.category_id = c.id
       LEFT JOIN brands AS b ON p.brand_id = b.id
       WHERE ${userId ? 'w.user_id = ?' : 'w.guest_id = ?'}
       ORDER BY w.created_at DESC`,
      [userId || guestId],
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
router.post("/", optionalAuth, async (req, res) => {
  try {
    const { productId } = req.body
    const userId = req.user?.id;
    const guestId = req.headers['x-guest-id'] || req.query.guest_id;

    if (!productId) {
      return res.status(400).json({ error: "Product ID is required" })
    }

    if (!userId && !guestId) {
      return res.status(401).json({ error: "Authentication or Guest ID required" })
    }

    // Check if product exists
    const [products] = await db.execute("SELECT id FROM products WHERE id = ?", [productId])
    if (products.length === 0) {
      return res.status(404).json({ error: "Product not found" })
    }

    // Check if item already in wishlist
    const [existing] = await db.execute(
      `SELECT id FROM wishlists WHERE ${userId ? 'user_id = ?' : 'guest_id = ?'} AND product_id = ?`,
      [userId || guestId, productId]
    )

    if (existing.length > 0) {
      return res.status(400).json({ error: "Item already in wishlist" })
    }

    // Add to wishlist
    const wishlistId = uuidv4()
    if (userId) {
      await db.execute("INSERT INTO wishlists (id, user_id, product_id) VALUES (?, ?, ?)", [
        wishlistId,
        userId,
        productId,
      ])
    } else {
      await db.execute("INSERT INTO wishlists (id, guest_id, product_id) VALUES (?, ?, ?)", [
        wishlistId,
        guestId,
        productId,
      ])
    }

    res.status(201).json({
      message: "Item added to wishlist successfully",
      wishlistId,
    })
  } catch (error) {
    console.error("Add to wishlist error:", error)
    res.status(500).json({ error: "Failed to add item to wishlist" })
  }
})

// Toggle item in wishlist (add if not exists, remove if exists)
router.post("/toggle", optionalAuth, async (req, res) => {
  try {
    const { productId } = req.body;
    const userId = req.user?.id;
    const guestId = req.headers['x-guest-id'] || req.query.guest_id;

    if (!productId) {
      return res.status(400).json({ error: "Product ID is required" });
    }

    if (!userId && !guestId) {
      return res.status(401).json({ error: "Authentication or Guest ID required" });
    }

    // Check if item already in wishlist
    const [existing] = await db.execute(
      `SELECT id FROM wishlists WHERE ${userId ? 'user_id = ?' : 'guest_id = ?'} AND product_id = ?`,
      [userId || guestId, productId]
    );

    if (existing.length > 0) {
      // Remove
      await db.execute(
        `DELETE FROM wishlists WHERE id = ?`,
        [existing[0].id]
      );
      return res.json({ message: "Item removed from wishlist", action: 'removed' });
    } else {
      // Add
      const wishlistId = uuidv4();
      if (userId) {
        await db.execute("INSERT INTO wishlists (id, user_id, product_id) VALUES (?, ?, ?)", [
          wishlistId, userId, productId
        ]);
      } else {
        await db.execute("INSERT INTO wishlists (id, guest_id, product_id) VALUES (?, ?, ?)", [
          wishlistId, guestId, productId
        ]);
      }
      return res.status(201).json({ message: "Item added to wishlist", wishlistId, action: 'added' });
    }
  } catch (error) {
    console.error("Toggle wishlist error:", error);
    res.status(500).json({ error: "Failed to toggle wishlist item" });
  }
});

// Merge guest wishlist into user wishlist
router.post("/merge", optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const guestId = req.headers['x-guest-id'] || req.body.guest_id;

    if (!userId || !guestId) {
      return res.status(400).json({ error: "Both User ID (via auth) and Guest ID are required" });
    }

    // Get guest items
    const [guestItems] = await db.execute(
      "SELECT product_id FROM wishlists WHERE guest_id = ?",
      [guestId]
    );

    if (guestItems.length === 0) {
      return res.json({ message: "No guest items to merge" });
    }

    // Get user items to avoid duplicates
    const [userItems] = await db.execute(
      "SELECT product_id FROM wishlists WHERE user_id = ?",
      [userId]
    );
    const userProductIds = userItems.map(item => item.product_id);

    // Merge
    let mergedCount = 0;
    for (const item of guestItems) {
      if (!userProductIds.includes(item.product_id)) {
        await db.execute(
          "INSERT INTO wishlists (id, user_id, product_id) VALUES (?, ?, ?)",
          [uuidv4(), userId, item.product_id]
        );
        mergedCount++;
      }
    }

    // Optionally delete guest items after merge
    await db.execute("DELETE FROM wishlists WHERE guest_id = ?", [guestId]);

    res.json({ message: `Successfully merged ${mergedCount} items`, mergedCount });
  } catch (error) {
    console.error("Merge wishlist error:", error);
    res.status(500).json({ error: "Failed to merge wishlist" });
  }
});

// Remove item from wishlist
router.delete("/:productId", optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const guestId = req.headers['x-guest-id'] || req.query.guest_id;

    if (!userId && !guestId) {
      return res.status(401).json({ error: "Authentication or Guest ID required" })
    }

    const [result] = await db.execute(
      `DELETE FROM wishlists WHERE ${userId ? 'user_id = ?' : 'guest_id = ?'} AND product_id = ?`,
      [userId || guestId, req.params.productId]
    )

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