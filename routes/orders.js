import express from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../config/database.js";
import { authenticateToken } from "../middleware/auth.js";

const router = express.Router()

// Get user's orders
// router.get("/", authenticateToken, async (req, res) => {
//   try {
//     const [orders] = await db.execute(
//       `SELECT 
//         o.id, o.order_date, o.total_amount, o.status, o.subtotal, 
//         o.shipping_cost, o.tax_amount, o.payment_method, o.payment_status
//        FROM orders o
//        WHERE o.user_id = ?
//        ORDER BY o.order_date DESC`,
//       [req.user.id],
//     )

//     // Get order items for each order
//     for (const order of orders) {
//       const [items] = await db.execute(
//         `SELECT 
//           oi.quantity, oi.price_at_purchase, oi.product_name_at_purchase, 
//           oi.image_url_at_purchase, p.id as product_id
//          FROM order_items oi
//          LEFT JOIN products p ON oi.product_id = p.id
//          WHERE oi.order_id = ?`,
//         [order.id],
//       )
//       order.items = items
//     }

//     res.json(orders)
//   } catch (error) {
//     console.error("Get orders error:", error)
//     res.status(500).json({ error: "Failed to fetch orders" })
//   }
// })
router.get("/",authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Your performant query is correct
    const query = `
      SELECT 
        o.*,
        (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', oi.id, 'product_id', oi.product_id, 'quantity', oi.quantity, 'price_at_purchase', oi.price_at_purchase, 'product_name_at_purchase', oi.product_name_at_purchase, 'image_url_at_purchase', oi.image_url_at_purchase)) FROM order_items oi WHERE oi.order_id = o.id) as items
      FROM orders o
      WHERE o.user_id = ?
      ORDER BY o.created_at DESC
    `;

    const [orders] = await db.execute(query, [userId]);
    
    const formattedOrders = orders.map(order => ({
      ...order,
      items: order.items || [] 
    }));

    // --- THIS IS THE KEY FIX ---
    // Always wrap the response in a structured object.
    res.json({
      orders: formattedOrders,
      total: formattedOrders.length, // Calculate total from the array length
      page: 1,
      totalPages: 1
    });

  } catch (error) {
    console.error("Get orders error:", error);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// Create order
// router.post("/", authenticateToken, async (req, res) => {
//   try {
//     const { shippingAddress, paymentMethod } = req.body

//     if (!shippingAddress || !paymentMethod) {
//       return res.status(400).json({ error: "Shipping address and payment method are required" })
//     }

//     // Get user's cart
//     const [carts] = await db.execute("SELECT id FROM carts WHERE user_id = ?", [req.user.id])

//     if (carts.length === 0) {
//       return res.status(400).json({ error: "Cart is empty" })
//     }

//     const cartId = carts[0].id

//     // Get cart items
//     const [cartItems] = await db.execute(
//       `SELECT 
//         ci.product_id, ci.quantity,
//         p.name, p.price, p.image_url, p.availability
//        FROM cart_items ci
//        JOIN products p ON ci.product_id = p.id
//        WHERE ci.cart_id = ?`,
//       [cartId],
//     )

//     if (cartItems.length === 0) {
//       return res.status(400).json({ error: "Cart is empty" })
//     }

//     // Check product availability
//     for (const item of cartItems) {
//       if (item.availability === "Out of Stock") {
//         return res.status(400).json({
//           error: `Product "${item.name}" is out of stock`,
//         })
//       }
//     }

//     // Calculate totals
//     const subtotal = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0)
//     const shippingCost = subtotal > 100 ? 0 : 10 // Free shipping over $100
//     const taxAmount = subtotal * 0.08 // 8% tax
//     const totalAmount = subtotal + shippingCost + taxAmount

//     // Create order
//     const orderId = uuidv4()
//     await db.execute(
//       `INSERT INTO orders 
//        (id, user_id, order_date, subtotal, shipping_cost, tax_amount, total_amount, 
//         status, payment_method, payment_status, shipping_address) 
//        VALUES (?, ?, CURDATE(), ?, ?, ?, ?, 'pending', ?, 'pending', ?)`,
//       [
//         orderId,
//         req.user.id,
//         subtotal,
//         shippingCost,
//         taxAmount,
//         totalAmount,
//         paymentMethod,
//         JSON.stringify(shippingAddress),
//       ],
//     )

//     // Create order items
//     for (const item of cartItems) {
//       const orderItemId = uuidv4()
//       await db.execute(
//         `INSERT INTO order_items 
//          (id, order_id, product_id, quantity, price_at_purchase, 
//           product_name_at_purchase, image_url_at_purchase) 
//          VALUES (?, ?, ?, ?, ?, ?, ?)`,
//         [orderItemId, orderId, item.product_id, item.quantity, item.price, item.name, item.image_url],
//       )
//     }

//     // Clear cart
//     await db.execute("DELETE FROM cart_items WHERE cart_id = ?", [cartId])

//     res.status(201).json({
//       message: "Order created successfully",
//       orderId,
//       totalAmount,
//     })
//   } catch (error) {
//     console.error("Create order error:", error)
//     res.status(500).json({ error: "Failed to create order" })
//   }
// })
router.post("/", authenticateToken, async (req, res, next) => {
  // We only need the shipping address and payment method from the frontend.
  // All calculations will be done securely on the backend.
  const { shipping_address, payment_method } = req.body;

  if (!shipping_address || !payment_method) {
    return res.status(400).json({ error: "Shipping address and payment method are required" });
  }

  const connection = await db.getConnection(); // Use a transaction for data safety
  try {
    await connection.beginTransaction();

    // 1. Get the user's cart
    const [carts] = await connection.execute("SELECT id FROM carts WHERE user_id = ?", [req.user.id]);
    if (carts.length === 0) {
      throw new Error("Cart not found for this user.");
    }
    const cartId = carts[0].id;

    // 2. Get cart items to calculate totals and create order items
    const [cartItems] = await connection.execute(
      `SELECT ci.product_id, ci.quantity, p.name, p.price, p.image, p.in_stock 
       FROM cart_items ci JOIN products p ON ci.product_id = p.id 
       WHERE ci.cart_id = ?`,
      [cartId]
    );

    if (cartItems.length === 0) {
      throw new Error("Cart is empty.");
    }

    // 3. Final validation and calculation on the backend
    const subtotal = cartItems.reduce((sum, item) => {
      if (item.in_stock < item.quantity) {
        throw new Error(`Not enough stock for "${item.name}". Only ${item.in_stock} available.`);
      }
      return sum + parseFloat(item.price) * item.quantity;
    }, 0);

    const shipping_cost = subtotal > 100 ? 0 : 25.0; // Your business logic for shipping
    const tax_amount = subtotal * 0.15; // Your business logic for tax
    const total_amount = subtotal + shipping_cost + tax_amount;

    // 4. Create the main order record
    const newOrderId = uuidv4();
    await connection.execute(
      `INSERT INTO orders (id, user_id, created_at, subtotal, shipping_cost, tax_amount, total, status, payment_method, payment_status, shipping_address) 
       VALUES (?, ?, NOW(), ?, ?, ?, ?, 'processing', ?, 'pending', ?)`,
      [newOrderId, req.user.id, subtotal, shipping_cost, tax_amount, total_amount, payment_method, JSON.stringify(shipping_address)]
    );

    // 5. Create the associated order_items records
    const orderItemPromises = cartItems.map(item => {
      // return connection.execute(
      //   `INSERT INTO order_items (id, order_id, product_id, quantity, price_at_purchase, product_name_at_purchase, image_url_at_purchase) 
      //    VALUES (?, ?, ?, ?, ?, ?, ?)`,
      //   [uuidv4(), newOrderId, item.product_id, item.quantity, item.price, item.name, item.image_url]
      // );
      const createOrderItemPromise = connection.execute(
        `INSERT INTO order_items (id, order_id, product_id, quantity, price_at_purchase, product_name_at_purchase, image_url_at_purchase) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), newOrderId, item.product_id, item.quantity, item.price, item.name, item.image_url]
      );
      
      // Operation 2: Reduce the stock for the product.
      const updateStockPromise = connection.execute(
        // The column name is `in_stock`.
        `UPDATE products SET in_stock = in_stock - ? WHERE id = ?`,
        [item.quantity, item.product_id]
      );
      
      // Return a promise that resolves when BOTH operations are complete.
      return Promise.all([createOrderItemPromise, updateStockPromise]);
    });
    await Promise.all(orderItemPromises);

    // 6. Clear the user's cart
    await connection.execute("DELETE FROM cart_items WHERE cart_id = ?", [cartId]);

    // 7. Commit the transaction
    await connection.commit();

    // 8. Send the successful response WITH THE ORDER ID
    res.status(201).json({
      message: "Order created successfully",
      orderId: newOrderId, // This is the key your frontend needs!
    });

  } catch (error) {
    await connection.rollback(); // Undo all changes if any step failed
    console.error("Create order error:", error);
    // Send a more informative error to the frontend
    res.status(400).json({ message: error.message || "Failed to create order" });
  } finally {
    connection.release(); // Release the connection back to the pool
  }
});

router.get("/:orderId", authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.id;

    // A query similar to your "get all orders" query, but for a single ID.
    // It's crucial to also check for user_id to ensure a user can only access their own orders.
    const query = `
      SELECT 
        o.id, o.created_at, o.total, o.status, o.subtotal, 
        o.shipping_cost, o.tax_amount, o.payment_method, o.payment_status,
        o.shipping_address,
        (SELECT JSON_ARRAYAGG(
          JSON_OBJECT(
            'id', oi.id, 
            'product_id', oi.product_id, 
            'quantity', oi.quantity, 
            'price_at_purchase', oi.price_at_purchase, 
            'product_name_at_purchase', oi.product_name_at_purchase, 
            'image_url_at_purchase', oi.image_url_at_purchase
          )
        ) 
        FROM order_items oi WHERE oi.order_id = o.id
        ) as items
      FROM orders o
      WHERE o.id = ? AND o.user_id = ?
    `;

    const [orders] = await db.execute(query, [orderId, userId]);

    // If no order is found (or it belongs to another user), return a 404
    if (orders.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    // We expect only one order, so take the first result
    const order = orders[0];

    // The database returns JSON fields as strings, so we need to parse them
    // back into objects for the frontend.
    order.items = order.items || []; // Handle cases with no items
    
    // Your frontend expects shipping_address to be an object, not a string
    if (order.shipping_address && typeof order.shipping_address === 'string') {
        try {
            order.shipping_address = JSON.parse(order.shipping_address);
        } catch (e) {
            console.error("Failed to parse shipping_address JSON:", e);
            // Handle cases where the JSON is invalid, maybe return null
            order.shipping_address = null;
        }
    }

    res.json(order);

  } catch (error) {
    console.error("Get order details error:", error);
    res.status(500).json({ error: "Failed to fetch order details" });
  }
});

export default router;