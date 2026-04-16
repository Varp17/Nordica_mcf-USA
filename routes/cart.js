import express from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../config/database.js";
import * as Product from "../models/Product.js";
import { authenticateToken } from "../middleware/auth.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * Helper to fetch full cart details with sanitized product data
 * EDGE CASE #43: Select only needed product columns (security)
 */
const getFullCart = async (cartId, connection = null) => {
  const dbConn = connection || db;
  const [cartItems] = await dbConn.execute(
    `SELECT 
      ci.id, ci.quantity, ci.added_at, ci.cart_id, ci.product_id,
      p.name, p.price, p.original_price, p.description, p.image_url, p.rating, p.reviews, p.in_stock, p.availability
     FROM cart_items ci
     JOIN products p ON ci.product_id = p.id
     WHERE ci.cart_id = ?`,
    [cartId],
  );

  const subtotal = cartItems.reduce((sum, item) => sum + parseFloat(item.price) * item.quantity, 0);

  return {
    id: cartId,
    items: cartItems.map(item => ({
      id: item.id,
      cart_id: item.cart_id,
      product_id: item.product_id,
      quantity: item.quantity,
      added_at: item.added_at,
      product: {
        id: item.product_id,
        name: item.name,
        price: parseFloat(item.price),
        original_price: item.original_price ? parseFloat(item.original_price) : undefined,
        description: item.description,
        image_url: item.image_url,
        rating: item.rating ? parseFloat(item.rating) : undefined,
        reviews: item.reviews,
        in_stock: item.in_stock,
        availability: item.availability
      },
    })),
    subtotal: parseFloat(subtotal.toFixed(2)),
    itemCount: cartItems.reduce((sum, item) => sum + item.quantity, 0),
  };
};

/**
 * GET /api/cart
 * Fetch authenticated user's cart
 */
router.get("/", authenticateToken, async (req, res, next) => {
  try {
    const [carts] = await db.execute("SELECT id FROM carts WHERE user_id = ?", [req.user.id]);

    if (carts.length === 0) {
      return res.json({ id: null, items: [], subtotal: 0, itemCount: 0 });
    }

    const cart = await getFullCart(carts[0].id);
    res.json(cart);
  } catch (error) {
    logger.error(`Get cart error: ${error.message}`);
    next(error);
  }
});

/**
 * POST /api/cart/items
 * Add item to cart with stock validation and atomic transactions
 */
router.post("/items", authenticateToken, async (req, res, next) => {
  const { productId, quantity = 1 } = req.body;

  if (!productId || quantity < 1) {
    return res.status(400).json({ success: false, message: "Product ID and a valid quantity are required" });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Get or create the user's cart
    let [carts] = await connection.execute("SELECT id FROM carts WHERE user_id = ? FOR UPDATE", [req.user.id]);
    let cartId;
    if (carts.length === 0) {
      cartId = uuidv4();
      await connection.execute("INSERT INTO carts (id, user_id) VALUES (?, ?)", [cartId, req.user.id]);
    } else {
      cartId = carts[0].id;
    }

    // 2. Check product availability
    // EDGE CASE #45: Stock check inside transaction
    const stockStatus = await Product.checkStock(productId, quantity);
    if (!stockStatus.valid) {
       // EDGE CASE #40: Fix transaction leak by rolling back before early return
       await connection.rollback();
       return res.status(400).json({ 
         success: false, 
         message: `Insufficient stock for ${stockStatus.name || 'product'}. Available: ${stockStatus.currentStock || 0}` 
       });
    }

    // 3. Check if item already in cart
    const [existingItems] = await connection.execute(
      "SELECT id, quantity FROM cart_items WHERE cart_id = ? AND product_id = ? FOR UPDATE",
      [cartId, productId],
    );

    if (existingItems.length > 0) {
      const newQuantity = existingItems[0].quantity + quantity;
      await connection.execute(
        "UPDATE cart_items SET quantity = ?, updated_at = NOW() WHERE id = ?", 
        [newQuantity, existingItems[0].id]
      );
    } else {
      await connection.execute(
        "INSERT INTO cart_items (id, cart_id, product_id, quantity, added_at) VALUES (?, ?, ?, ?, NOW())",
        [uuidv4(), cartId, productId, quantity]
      );
    }
    
    await connection.execute("UPDATE carts SET updated_at = NOW() WHERE id = ?", [cartId]);

    await connection.commit();
    
    // EDGE CASE #44: Standardized response shape
    const updatedCart = await getFullCart(cartId);
    res.json(updatedCart);

  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`Add item to cart error: ${error.message}`);
    next(error);
  } finally {
    if (connection) connection.release();
  }
});

/**
 * PUT /api/cart/items/:productId
 * Update specific item quantity with stock validation
 * EDGE CASE #41: Use transaction for atomic check and update
 */
router.put("/items/:productId", authenticateToken, async (req, res, next) => {
  const { quantity } = req.body;
  const { productId } = req.params;

  if (quantity === undefined || quantity < 1) {
    return res.status(400).json({ success: false, message: "Valid quantity is required" });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [carts] = await connection.execute("SELECT id FROM carts WHERE user_id = ? FOR UPDATE", [req.user.id]);
    if (carts.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: "Cart not found" });
    }
    const cartId = carts[0].id;

    const stockStatus = await Product.checkStock(productId, quantity);
    if (!stockStatus.valid) {
      await connection.rollback();
      return res.status(400).json({ 
        success: false, 
        message: `Only ${stockStatus.currentStock || 0} in stock.` 
      });
    }

    const [result] = await connection.execute(
      "UPDATE cart_items SET quantity = ?, updated_at = NOW() WHERE cart_id = ? AND product_id = ?",
      [quantity, cartId, productId]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: "Item not found in cart" });
    }

    await connection.execute("UPDATE carts SET updated_at = NOW() WHERE id = ?", [cartId]);
    await connection.commit();

    const updatedCart = await getFullCart(cartId);
    res.json(updatedCart);
  } catch (error) {
    if (connection) await connection.rollback();
    logger.error(`Update cart error: ${error.message}`);
    next(error);
  } finally {
    if (connection) connection.release();
  }
});

/**
 * DELETE /api/cart/items/:productId
 */
router.delete("/items/:productId", authenticateToken, async (req, res, next) => {
  try {
    const { productId } = req.params;
    const [carts] = await db.execute("SELECT id FROM carts WHERE user_id = ?", [req.user.id]);
    if (carts.length === 0) return res.status(404).json({ success: false, message: "Cart not found" });

    const cartId = carts[0].id;
    const [result] = await db.execute("DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?", [cartId, productId]);
    
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: "Item not found in cart" });

    await db.execute("UPDATE carts SET updated_at = NOW() WHERE id = ?", [cartId]);
    const updatedCart = await getFullCart(cartId);
    res.json(updatedCart);
  } catch (error) {
    logger.error(`Remove from cart error: ${error.message}`);
    next(error);
  }
});

/**
 * DELETE /api/cart
 */
router.delete("/", authenticateToken, async (req, res, next) => {
  try {
    const [carts] = await db.execute("SELECT id FROM carts WHERE user_id = ?", [req.user.id]);
    if (carts.length === 0) return res.status(404).json({ success: false, message: "Cart not found" });

    const cartId = carts[0].id;
    await db.execute("DELETE FROM cart_items WHERE cart_id = ?", [cartId]);
    await db.execute("UPDATE carts SET updated_at = NOW() WHERE id = ?", [cartId]);

    res.json({ success: true, message: "Cart cleared", id: cartId, items: [], subtotal: 0, itemCount: 0 });
  } catch (error) {
    logger.error(`Clear cart error: ${error.message}`);
    next(error);
  }
});

export default router;