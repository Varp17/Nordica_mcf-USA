import db from '../config/database.js';
import { generateOrderNumber, generateUUID } from '../utils/helpers.js';
import * as Product from './Product.js';
import logger from '../utils/logger.js';

export async function createOrder(orderData) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Deduct Stock first (will fail if not enough or error)
    await Product.deductStock(orderData.items, conn);
    
    // 1.5 Generate Serial Order Number via Stored Procedure
    await conn.execute('CALL generate_order_number(@orderNum)');
    const [[{ orderNumber: serialNum }]] = await conn.execute('SELECT @orderNum AS orderNumber');
    
    const orderId = generateUUID();
    const orderNumber = serialNum || generateOrderNumber(); // Fallback to random if proc fails
    
    // Final check for collision in the DB (Safety Constraint)
    const [existing] = await conn.execute('SELECT id FROM orders WHERE order_number = ?', [orderNumber]);
    if (existing.length > 0) {
      // If by some miracle it exists, retry once with a random suffix or fail
      throw new Error(`Order collision detected on ${orderNumber}. Please try again.`);
    }

    const isUS = orderData.country === 'US';
    const s = orderData.shipping;

    // Build the required JSON blob that mirrors the individual fields
    const shippingAddressJson = JSON.stringify({
      firstName:  s.firstName,
      lastName:   s.lastName,
      company:    s.company      || null,
      address1:   s.address1     || s.address,
      address2:   s.address2     || s.apartment || null,
      city:       s.city,
      state:      s.state        || s.province  || null,
      province:   s.province     || s.state     || null,
      zip:        s.zip          || s.postalCode|| null,
      postalCode: s.postalCode   || s.zip       || null,
      phone:      s.phone        || null,
      country:    orderData.country
    });

    await conn.execute(
      `INSERT INTO orders (
         id, order_number, user_id, customer_email, country,
         shipping_first_name, shipping_last_name, shipping_company,
         shipping_address1, shipping_address2,
         shipping_city,
         shipping_state, shipping_province,
         shipping_zip, shipping_postal_code, shipping_phone,
         shipping_speed, shipping_address,
         subtotal, tax, shipping_cost, total,
         currency, status, payment_status, fulfillment_status,
         payment_method, payment_reference,
         notes, created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?,
         ?, ?, ?,
         ?, ?,
         ?,
         ?, ?,
         ?, ?, ?,
         ?, ?,
         ?, ?, ?, ?,
         ?, 'pending', ?, 'pending',
         ?, ?,
         ?, NOW(), NOW()
       )`,
      [
        orderId, orderNumber, orderData.customerId || null, orderData.customer_email || null, orderData.country || null,
        s.firstName || null, s.lastName || null, s.company || null,
        s.address1 || s.address || null, s.address2 || s.apartment || null,
        s.city || null,
        (s.state || s.province || null), (s.province || s.state || null),
        (s.zip || s.postalCode || null), (s.postalCode || s.zip || null),
        s.phone || null,
        orderData.shippingSpeed || 'standard', shippingAddressJson,
        orderData.subtotal || 0, orderData.tax || 0, orderData.shippingCost || 0, orderData.total || 0,
        orderData.currency || (orderData.country === 'CA' ? 'CAD' : 'USD'),
        orderData.paymentStatus || 'pending',
        orderData.paymentMethod || null, orderData.paymentReference || null,
        orderData.notes || null
      ]
    );

    for (const item of orderData.items) {
      const unitPrice = parseFloat(item.unitPrice || item.unit_price || 0);
      const quantity = parseInt(item.quantity) || 1;
      const totalPrice = parseFloat((unitPrice * quantity).toFixed(2));
      const productName = item.productName || item.product_name || 'Product';
      const imageUrl = item.image || item.image_url || null;

      await conn.execute(
        `INSERT INTO order_items (
           id, order_id, product_variant_id, product_id,
           sku, fnsku, product_name, quantity, 
           unit_price, total_price,
           price_at_purchase, product_name_at_purchase, image_url_at_purchase,
           weight_kg, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          generateUUID(), 
          orderId, 
          item.variantId || item.product_variant_id || null, 
          item.productId || item.product_id || null,
          item.sku || null, 
          item.fnsku || null, 
          productName, 
          quantity,
          unitPrice, 
          totalPrice,
          unitPrice, // price_at_purchase
          productName, // product_name_at_purchase
          imageUrl, // image_url_at_purchase
          item.weightKg || item.weight_kg || 0.5
        ]
      );
    }

    await conn.commit();
    return findById(orderId);
  } catch (err) {
    await conn.rollback();

    throw err;
  } finally {
    conn.release();
  }
}

export async function findById(orderId) {
  const [orders] = await db.query(
    `SELECT o.*, u.email AS cust_email, u.first_name AS cust_first_name, u.last_name AS cust_last_name 
     FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ?`,
    [orderId]
  );
  if (!orders.length) return null;
  const order = orders[0];
  const [items] = await db.query(`SELECT * FROM order_items WHERE order_id = ? ORDER BY created_at ASC`, [orderId]);
  order.items = items;
  return order;
}

export async function findByOrderNumber(orderNumber) {
  const [rows] = await db.query(`SELECT id FROM orders WHERE order_number = ?`, [orderNumber]);
  if (!rows.length) return null;
  return findById(rows[0].id);
}

export async function findByCustomer(customerId, { page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  
  // EDGE CASE #99: Fetch user email to find guest orders associated with this account
  const [userRows] = await db.query('SELECT email FROM users WHERE id = ?', [customerId]);
  const userEmail = userRows[0]?.email || null;

  const [rows] = await db.query(
    `SELECT * FROM orders 
     WHERE user_id = ? 
     ${userEmail ? 'OR (user_id IS NULL AND LOWER(customer_email) = LOWER(?))' : ''}
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    userEmail ? [customerId, userEmail, limit, offset] : [customerId, limit, offset]
  );

  if (rows.length === 0) return { orders: [], total: 0, page, limit };
  const orderIds = rows.map(r => r.id);
  
  let allItems = [];
  if (orderIds.length > 0) {
    const [itemRows] = await db.query(`SELECT * FROM order_items WHERE order_id IN (?) ORDER BY created_at ASC`, [orderIds]);
    allItems = itemRows;
  }
  
  const orders = rows.map(order => ({ ...order, items: allItems.filter(item => item.order_id === order.id) }));
  
  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM orders 
     WHERE user_id = ? 
     ${userEmail ? 'OR (user_id IS NULL AND LOWER(customer_email) = LOWER(?))' : ''}`,
    userEmail ? [customerId, userEmail] : [customerId]
  );
  
  return { orders, total, page, limit };
}

export async function updatePaymentStatus(orderId, { paymentStatus, paymentReference, paymentMethod }) {
  await db.query(
    `UPDATE orders SET 
       payment_status = ?, 
       payment_reference = COALESCE(?, payment_reference), 
       payment_method = COALESCE(?, payment_method), 
       paid_at = CASE WHEN ? = 'paid' THEN NOW() ELSE paid_at END, 
       updated_at = NOW() 
     WHERE id = ?`,
    [
      paymentStatus, 
      paymentReference !== undefined ? paymentReference : null, 
      paymentMethod !== undefined ? paymentMethod : null, 
      paymentStatus, 
      orderId
    ]
  );

  // If order is paid, update user stats (total spent, total orders)
  if (paymentStatus === 'paid') {
    try {
      const [orderRows] = await db.query('SELECT user_id, total FROM orders WHERE id = ?', [orderId]);
      if (orderRows.length > 0 && orderRows[0].user_id) {
        const userId = orderRows[0].user_id;
        await db.execute(
          `UPDATE users u
           SET u.total_orders = (SELECT COUNT(*) FROM orders WHERE user_id = ? AND payment_status = 'paid'),
               u.total_spent = (SELECT COALESCE(SUM(total), 0) FROM orders WHERE user_id = ? AND payment_status = 'paid'),
               u.updated_at = NOW()
           WHERE u.id = ?`,
          [userId, userId, userId]
        );
        logger.info(`User stats updated for customer ${userId} after payment.`);
      }
    } catch (err) {
      logger.error(`Failed to update customer stats: ${err.message}`);
    }
  }

  return findById(orderId);
}

export async function updateOrderStatus(orderId, status, notes = null) {
  await db.query(
    `UPDATE orders SET status = ?, notes = COALESCE(?, notes), updated_at = NOW() WHERE id = ?`,
    [status, notes !== undefined ? notes : null, orderId]
  );
  return findById(orderId);
}

// EDGE CASE #22: Whitelist allowed column names to prevent SQL injection
const ALLOWED_ORDER_COLUMNS = new Set([
  'status', 'payment_status', 'payment_reference', 'payment_method',
  'fulfillment_status', 'fulfillment_channel', 'fulfillment_error',
  'amazon_fulfillment_id', 'mcf_order_id',
  'shippo_tracking_number', 'shippo_carrier', 'shippo_tracking_status',
  'shippo_label_url', 'shippo_transaction_id', 'shippo_tracking_raw',
  'service_name', 'estimated_delivery',
  'tracking_number', 'tracking_url', 'carrier', 'label_url',
  'actual_shipping_cost', 'shipping_profit_loss',
  'notes', 'invoice_pdf_url',
  'shipping_cost', 'tax', 'subtotal', 'total', 'currency'
]);

export async function updateOrder(orderId, fields) {
  // Filter to only whitelisted columns
  const safeFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (ALLOWED_ORDER_COLUMNS.has(key)) {
      safeFields[key] = value === undefined ? null : value;
    } else {
      logger.warn(`updateOrder: Rejected non-whitelisted column '${key}' for order ${orderId}`);
    }
  }
  if (Object.keys(safeFields).length === 0) {
    logger.warn(`updateOrder: No valid columns to update for order ${orderId}`);
    return findById(orderId);
  }
  // EDGE CASE #23: Use NOW() instead of JS Date for consistent timezone
  const setClauses = Object.keys(safeFields).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(safeFields), orderId];
  await db.query(`UPDATE orders SET ${setClauses}, updated_at = NOW() WHERE id = ?`, values);
  return findById(orderId);
}

export async function updateFulfillmentStatus(orderId, status) {
  await db.query(
    `UPDATE orders SET fulfillment_status = ?, updated_at = NOW() WHERE id = ?`,
    [status, orderId]
  );
  return findById(orderId);
}

export default { createOrder, findById, findByOrderNumber, findByCustomer, updatePaymentStatus, updateFulfillmentStatus, updateOrderStatus, updateOrder };
