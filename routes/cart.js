import express from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../config/database.js";
import * as Product from "../models/Product.js";
import { authenticateToken } from "../middleware/auth.js";

const router = express.Router()

// Get user's cart
// router.get("/", authenticateToken, async (req, res) => {
//   try {
//     // Get or create cart for user
//     let [carts] = await db.execute("SELECT id FROM carts WHERE user_id = ?", [req.user.id])

//     if (carts.length === 0) {
//       // Create cart if it doesn't exist
//       const cartId = uuidv4()
//       await db.execute("INSERT INTO carts (id, user_id) VALUES (?, ?)", [cartId, req.user.id])
//       carts = [{ id: cartId }]
//     }

//     const cartId = carts[0].id

//     // Get cart items with product details
//     const [cartItems] = await db.execute(
//       `SELECT 
//         ci.id, ci.product_id, ci.quantity,
//         p.name, p.price, p.image_url, p.availability
//        FROM cart_items ci
//        JOIN products p ON ci.product_id = p.id
//        WHERE ci.cart_id = ?`,
//       [cartId],
//     )

//     // Calculate totals
//     const total = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0)
//     const itemCount = cartItems.reduce((sum, item) => sum + item.quantity, 0)

//     const cart = {
//       id: cartId,
//       items: cartItems.map((item) => ({
//         id: item.id,
//         product_id: item.product_id,
//         name: item.name,
//         price: item.price,
//         quantity: item.quantity,
//         image_url: item.image_url,
//         availability: item.availability,
//       })),
//       total,
//       itemCount,
//     }

//     res.json({ cart })
//   } catch (error) {
//     console.error("Get cart error:", error)
//     res.status(500).json({ error: "Failed to fetch cart" })
//   }
// })

// // Add item to cart
// router.post("/items", authenticateToken, async (req, res) => {
//   try {
//     const { productId, quantity = 1 } = req.body

//     if (!productId) {
//       return res.status(400).json({ error: "Product ID is required" })
//     }

//     if (quantity < 1) {
//       return res.status(400).json({ error: "Quantity must be at least 1" })
//     }

//     // Check if product exists and is available
//     const [products] = await db.execute("SELECT id, availability FROM products WHERE id = ?", [productId])
//     if (products.length === 0) {
//       return res.status(404).json({ error: "Product not found" })
//     }

//     if (products[0].availability === "Out of Stock") {
//       return res.status(400).json({ error: "Product is out of stock" })
//     }

//     // Get or create cart
//     let [carts] = await db.execute("SELECT id FROM carts WHERE user_id = ?", [req.user.id])

//     if (carts.length === 0) {
//       const cartId = uuidv4()
//       await db.execute("INSERT INTO carts (id, user_id) VALUES (?, ?)", [cartId, req.user.id])
//       carts = [{ id: cartId }]
//     }

//     const cartId = carts[0].id

//     // Check if item already in cart
//     const [existingItems] = await db.execute(
//       "SELECT id, quantity FROM cart_items WHERE cart_id = ? AND product_id = ?",
//       [cartId, productId],
//     )

//     if (existingItems.length > 0) {
//       // Update quantity
//       const newQuantity = existingItems[0].quantity + quantity
//       await db.execute("UPDATE cart_items SET quantity = ?, updated_at = NOW() WHERE id = ?", [
//         newQuantity,
//         existingItems[0].id,
//       ])
//     } else {
//       // Add new item
//       const cartItemId = uuidv4()
//       await db.execute("INSERT INTO cart_items (id, cart_id, product_id, quantity) VALUES (?, ?, ?, ?)", [
//         cartItemId,
//         cartId,
//         productId,
//         quantity,
//       ])
//     }

//     // Return updated cart
//     const [cartItems] = await db.execute(
//       `SELECT 
//         ci.id, ci.product_id, ci.quantity,
//         p.name, p.price, p.image_url, p.availability
//        FROM cart_items ci
//        JOIN products p ON ci.product_id = p.id
//        WHERE ci.cart_id = ?`,
//       [cartId],
//     )

//     const total = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0)
//     const itemCount = cartItems.reduce((sum, item) => sum + item.quantity, 0)

//     const cart = {
//       id: cartId,
//       items: cartItems.map((item) => ({
//         id: item.id,
//         product_id: item.product_id,
//         name: item.name,
//         price: item.price,
//         quantity: item.quantity,
//         image_url: item.image_url,
//         availability: item.availability,
//       })),
//       total,
//       itemCount,
//     }

//     res.json({
//       message: "Item added to cart successfully",
//       cart,
//     })
//   } catch (error) {
//     console.error("Add to cart error:", error)
//     res.status(500).json({ error: "Failed to add item to cart" })
//   }
// })

const getFullCart = async (cartId) => {
  const [cartItems] = await db.execute(
    `SELECT 
      ci.id, ci.quantity, ci.added_at, ci.cart_id,
      p.* -- Select ALL columns from the products table
     FROM cart_items ci
     JOIN products p ON ci.product_id = p.id
     WHERE ci.cart_id = ?`,
    [cartId],
  );

  const subtotal = cartItems.reduce((sum, item) => sum + parseFloat(item.price) * item.quantity, 0);

  return {
    id: cartId,
    // --- THIS IS THE CRUCIAL FIX ---
    items: cartItems.map(item => {
      // Create the nested 'product' object
      const product = {
        id: item.product_id,
        name: item.name,
        price: parseFloat(item.price), // Also ensure price is a number
        original_price: item.original_price ? parseFloat(item.original_price) : undefined,
        description: item.description,
        image_url: item.image_url,
        rating: item.rating ? parseFloat(item.rating) : undefined,
        reviews: item.reviews,
        in_stock: item.in_stock,
        // Add any other product fields you need
      };

      // Return the object that matches the CartItem interface
      return {
        id: item.id, // The cart_item's own ID
        cart_id: item.cart_id,
        product_id: product.id,
        quantity: item.quantity,
        added_at: item.added_at,
        product: product, // The nested product object
      };
    }),
    subtotal: subtotal,
    itemCount: cartItems.reduce((sum, item) => sum + item.quantity, 0),
  };
};



// Get user's cart
router.get("/", authenticateToken, async (req, res, next) => {
  try {
    const [carts] = await db.execute("SELECT id FROM carts WHERE user_id = ?", [req.user.id]);

    if (carts.length === 0) {
      // If the user has no cart, return an empty cart structure
      return res.json({
        id: null,
        items: [],
        subtotal: 0,
        itemCount: 0,
      });
    }

    const cart = await getFullCart(carts[0].id);
    res.json(cart);

  } catch (error) {
    console.error("Get cart error:", error);
    next(error);
  }
});

// Add item to cart
router.post("/items", authenticateToken, async (req, res, next) => {
  const { productId, quantity = 1 } = req.body;

  if (!productId || quantity < 1) {
    return res.status(400).json({ error: "Product ID and a valid quantity are required" });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Get or create the user's cart
    let [carts] = await connection.execute("SELECT id FROM carts WHERE user_id = ?", [req.user.id]);
    let cartId;
    if (carts.length === 0) {
      cartId = uuidv4();
      await connection.execute("INSERT INTO carts (id, user_id) VALUES (?, ?)", [cartId, req.user.id]);
    } else {
      cartId = carts[0].id;
    }

    // 2. Check product availability
    const stockStatus = await Product.checkStock(productId, quantity);
    if (!stockStatus.available) {
      return res.status(400).json({ 
        success: false, 
        error: `Insufficient stock for ${stockStatus.name || 'product'}. Available: ${stockStatus.currentStock}` 
      });
    }

    /* Original basic check:
    const [products] = await connection.execute("SELECT in_stock FROM products WHERE id = ?", [productId]);
    if (products.length === 0 || products[0].in_stock <= 0) {
      throw new Error("Product not found or is out of stock");
    }
    */

    // 3. Check if item already in cart
    const [existingItems] = await connection.execute(
      "SELECT id, quantity FROM cart_items WHERE cart_id = ? AND product_id = ?",
      [cartId, productId],
    );

    if (existingItems.length > 0) {
      // --- FIX: This line caused the error and has been corrected ---
      // Update quantity of existing item
      const newQuantity = existingItems[0].quantity + quantity;
      await connection.execute(
        "UPDATE cart_items SET quantity = ? WHERE id = ?", 
        [newQuantity, existingItems[0].id]
      );
    } else {
      // Add new item to cart
      const cartItemId = uuidv4();
      await connection.execute(
        "INSERT INTO cart_items (id, cart_id, product_id, quantity) VALUES (?, ?, ?, ?)",
        [cartItemId, cartId, productId, quantity]
      );
    }
    
    // --- BEST PRACTICE: Now we update the parent cart's timestamp ---
    await connection.execute("UPDATE carts SET updated_at = NOW() WHERE id = ?", [cartId]);

    await connection.commit();
    
    const updatedCart = await getFullCart(cartId);
    res.status(200).json(updatedCart);

  } catch (error) {
    await connection.rollback();
    console.error("Add to cart error:", error);
    next(error);
  } finally {
    connection.release();
  }
});

// Update cart item quantity
router.put("/items/:productId", authenticateToken, async (req, res) => {
  try {
    const { quantity } = req.body
    const { productId } = req.params

    if (!quantity || quantity < 1) {
      return res.status(400).json({ error: "Valid quantity is required" })
    }

    // Get cart
    const [carts] = await db.execute("SELECT id FROM carts WHERE user_id = ?", [req.user.id])
    if (carts.length === 0) {
      return res.status(404).json({ error: "Cart not found" })
    }

    const cartId = carts[0].id

    // Check stock before updating
    const stockStatus = await Product.checkStock(productId, quantity);
    if (!stockStatus.available) {
      return res.status(400).json({ 
        success: false, 
        error: `Insufficient stock for ${stockStatus.name || 'product'}. Available: ${stockStatus.currentStock}` 
      });
    }

    // Update item quantity
    const [result] = await db.execute(
  "UPDATE cart_items SET quantity = ? WHERE cart_id = ? AND product_id = ?",
      [quantity, cartId, productId],
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Item not found in cart" })
    }

    // Return updated cart
    const [cartItems] = await db.execute(
      `SELECT 
        ci.id, ci.product_id, ci.quantity,
        p.name, p.price, p.image_url, p.availability
       FROM cart_items ci
       JOIN products p ON ci.product_id = p.id
       WHERE ci.cart_id = ?`,
      [cartId],
    )

    const total = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0)
    const itemCount = cartItems.reduce((sum, item) => sum + item.quantity, 0)

    const cart = {
      id: cartId,
      items: cartItems.map((item) => ({
        id: item.id,
        product_id: item.product_id,
        name: item.name,
        price: item.price,
        quantity: item.quantity,
        image_url: item.image_url,
        availability: item.availability,
      })),
      total,
      itemCount,
    }

    res.json({
      message: "Cart updated successfully",
      cart,
    })
  } catch (error) {
    console.error("Update cart error:", error)
    res.status(500).json({ error: "Failed to update cart" })
  }
})

// Remove item from cart
router.delete("/items/:productId", authenticateToken, async (req, res) => {
  try {
    const { productId } = req.params

    // Get cart
    const [carts] = await db.execute("SELECT id FROM carts WHERE user_id = ?", [req.user.id])
    if (carts.length === 0) {
      return res.status(404).json({ error: "Cart not found" })
    }

    const cartId = carts[0].id

    // Remove item
    const [result] = await db.execute("DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?", [
      cartId,
      productId,
    ])

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Item not found in cart" })
    }

    // Return updated cart
    const [cartItems] = await db.execute(
      `SELECT 
        ci.id, ci.product_id, ci.quantity,
        p.name, p.price, p.image_url, p.availability
       FROM cart_items ci
       JOIN products p ON ci.product_id = p.id
       WHERE ci.cart_id = ?`,
      [cartId],
    )

    const total = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0)
    const itemCount = cartItems.reduce((sum, item) => sum + item.quantity, 0)

    const cart = {
      id: cartId,
      items: cartItems.map((item) => ({
        id: item.id,
        product_id: item.product_id,
        name: item.name,
        price: item.price,
        quantity: item.quantity,
        image_url: item.image_url,
        availability: item.availability,
      })),
      total,
      itemCount,
    }

    res.json({
      message: "Item removed from cart successfully",
      cart,
    })
  } catch (error) {
    console.error("Remove from cart error:", error)
    res.status(500).json({ error: "Failed to remove item from cart" })
  }
})

// Clear cart
router.delete("/", authenticateToken, async (req, res) => {
  try {
    // Get cart
    const [carts] = await db.execute("SELECT id FROM carts WHERE user_id = ?", [req.user.id])
    if (carts.length === 0) {
      return res.status(404).json({ error: "Cart not found" })
    }

    const cartId = carts[0].id

    // Clear all items
    await db.execute("DELETE FROM cart_items WHERE cart_id = ?", [cartId])

    const cart = {
      id: cartId,
      items: [],
      total: 0,
      itemCount: 0,
    }

    res.json({
      message: "Cart cleared successfully",
      cart,
    })
  } catch (error) {
    console.error("Clear cart error:", error)
    res.status(500).json({ error: "Failed to clear cart" })
  }
})

export default router;