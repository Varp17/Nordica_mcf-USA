import db from '../config/database.js';
import { generateOrderNumber, generateUUID } from '../utils/helpers.js';

export async function createOrder(orderData) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const orderId = generateUUID();
    const orderNumber = generateOrderNumber();
    const isUS = orderData.country === 'US';
    const s = orderData.shipping;

    // Build the required JSON blob that mirrors the individual fields
    const shippingAddressJson = JSON.stringify({
      firstName:  s.firstName,
      lastName:   s.lastName,
      company:    s.company   || null,
      address1:   s.address1,
      address2:   s.address2  || null,
      city:       s.city,
      state:      s.state     || null,
      province:   s.province  || null,
      zip:        s.zip       || null,
      postalCode: s.postalCode|| null,
      phone:      s.phone     || null,
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
        orderId, orderNumber, orderData.customerId || null, orderData.customer_email, orderData.country,
        s.firstName, s.lastName, s.company || null,
        s.address1, s.address2 || null,
        s.city,
        isUS ? (s.state  || null) : null, !isUS ? (s.province || null) : null,
        isUS ? (s.zip    || null) : null, !isUS ? (s.postalCode || null) : null,
        s.phone || null,
        orderData.shippingSpeed || 'standard', shippingAddressJson,
        orderData.subtotal, orderData.tax || 0, orderData.shippingCost || 0, orderData.total,
        orderData.currency || (orderData.country === 'CA' ? 'CAD' : 'USD'),
        orderData.paymentStatus || 'pending',
        orderData.paymentMethod || null, orderData.paymentReference || null,
        orderData.notes || null
      ]
    );

    for (const item of orderData.items) {
      await conn.execute(
        `INSERT INTO order_items (
           id, order_id, product_variant_id, product_id,
           sku, fnsku, product_name, quantity, unit_price, total_price,
           weight_kg, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          generateUUID(), orderId, item.variantId || null, item.productId || null,
          item.sku, item.fnsku || null, item.productName, item.quantity,
          item.unitPrice, item.unitPrice * item.quantity,
          item.weightKg || 0.5
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
  const [rows] = await db.query(
    `SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [customerId, limit, offset]
  );
  if (rows.length === 0) return { orders: [], total: 0, page, limit };
  const orderIds = rows.map(r => r.id);
  const [allItems] = await db.query(`SELECT * FROM order_items WHERE order_id IN (?) ORDER BY created_at ASC`, [orderIds]);
  const orders = rows.map(order => ({ ...order, items: allItems.filter(item => item.order_id === order.id) }));
  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM orders WHERE user_id = ?`, [customerId]);
  return { orders, total, page, limit };
}

export async function updatePaymentStatus(orderId, { paymentStatus, paymentReference, paymentMethod }) {
  await db.query(
    `UPDATE orders SET payment_status = ?, payment_reference = COALESCE(?, payment_reference), payment_method = COALESCE(?, payment_method), paid_at = CASE WHEN ? = 'paid' THEN NOW() ELSE paid_at END, updated_at = NOW() WHERE id = ?`,
    [paymentStatus, paymentReference || null, paymentMethod || null, paymentStatus, orderId]
  );
  return findById(orderId);
}

export async function updateFulfillmentStatus(orderId, fields) {
  const allowed = ['fulfillment_status', 'fulfillment_channel', 'amazon_fulfillment_id', 'tracking_number', 'tracking_url', 'label_url', 'carrier', 'service_name', 'estimated_delivery', 'shippo_transaction_id', 'fulfillment_error'];
  const safeFields = Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(safeFields).length) return;
  const setClauses = Object.keys(safeFields).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(safeFields), new Date(), orderId];
  await db.query(`UPDATE orders SET ${setClauses}, updated_at = ? WHERE id = ?`, values);
}

export default { createOrder, findById, findByOrderNumber, findByCustomer, updatePaymentStatus, updateFulfillmentStatus };
