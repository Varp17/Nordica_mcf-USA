import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../config/database.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import Order from '../models/Order.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * POST /api/returns/request
 * Customer submits a return request with feedback.
 * Validates 4-day window.
 */
router.post('/request', optionalAuth, async (req, res) => {
  try {
    const { orderId, reasonCode, feedback, items, email } = req.body;

    if (!orderId) return res.status(400).json({ success: false, message: 'Order ID is required' });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Authorization check
    if (order.country !== 'US') {
      return res.status(400).json({ success: false, message: 'Returns are currently only available for orders within the USA.' });
    }

    let isAuthorized = false;
    if (req.user && (req.user.id === order.user_id || req.user.email?.toLowerCase() === order.customer_email?.toLowerCase())) {
      isAuthorized = true;
    } else if (email && email.toLowerCase() === order.customer_email?.toLowerCase()) {
      isAuthorized = true;
    }
    if (!isAuthorized) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    // Only allow returns for shipped/submitted orders
    const allowReturnStatuses = ['submitted_to_amazon', 'shipped', 'delivered', 'label_created', 'submitted_to_shippo'];
    if (!allowReturnStatuses.includes(order.fulfillment_status)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Returns can only be requested once an order has been shipped or processed.' 
      });
    }

    // Check 4-day window (from created_at as a fallback for delivery date)
    const createdAt = new Date(order.created_at);
    const now = new Date();
    const diffDays = Math.ceil((now - createdAt) / (1000 * 60 * 60 * 24));

    if (diffDays > 4) {
      return res.status(400).json({ 
        success: false, 
        message: `Returns are only allowed within 4 days of order. This order was placed ${diffDays} days ago.` 
      });
    }

    // Check if a request already exists
    const [existing] = await db.execute('SELECT id FROM return_requests WHERE order_id = ? AND status != "rejected"', [orderId]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'A return request already exists for this order.' });
    }

    const id = uuidv4();
    await db.execute(
      `INSERT INTO return_requests (id, order_id, customer_id, reason_code, customer_feedback, items, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id, 
        orderId, 
        order.user_id || null, 
        reasonCode, 
        feedback || '', 
        JSON.stringify(items || []), 
        'pending'
      ]
    );

    logger.info(`Return request ${id} created for order ${order.order_number}`);

    res.json({ 
      success: true, 
      message: 'Return request submitted successfully. It will be reviewed by our team.',
      requestId: id
    });
  } catch (error) {
    logger.error(`Return Request Error: ${error.message}`);
    res.status(500).json({ success: false, message: 'Failed to submit return request' });
  }
});

/**
 * GET /api/returns/my
 * Customer views their return requests.
 */
router.get('/my', authenticateToken, async (req, res) => {
  try {
    const [requests] = await db.execute(
      `SELECT r.*, o.order_number 
       FROM return_requests r
       JOIN orders o ON r.order_id = o.id
       WHERE r.customer_id = ? OR o.customer_email = ?
       ORDER BY r.created_at DESC`,
      [req.user.id, req.user.email]
    );
    res.json({ success: true, requests });
  } catch (error) {
    logger.error(`Get My Returns Error: ${error.message}`);
    res.status(500).json({ success: false, message: 'Failed to fetch return requests' });
  }
});

export default router;
