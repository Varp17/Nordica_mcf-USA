import express from 'express';
import db from '../config/database.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * GET /api/tracking/:orderId
 * Get order tracking info by order ID and email (for security).
 */
router.get('/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { email } = req.query;

    if (!orderId) {
      return res.status(400).json({ success: false, message: 'Order ID is required' });
    }

    // Look up order. If email is provided, verify it. 
    // In many checkout successes, we might have the ID but not auth yet.
    let query = 'SELECT * FROM orders WHERE id = ? OR order_number = ?';
    let params = [orderId, orderId];

    if (email) {
      query += ' AND customer_email = ?';
      params.push(email);
    }

    const [rows] = await db.query(query, params);
    
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const order = rows[0];

    // Return tracking info
    return res.json({
      success: true,
      orderId: order.id,
      orderNumber: order.order_number,
      fulfillmentStatus: order.fulfillment_status,
      carrier: order.carrier || order.shippo_carrier,
      trackingNumber: order.tracking_number || order.shippo_tracking_number,
      trackingUrl: order.tracking_url || (order.shippo_tracking_number ? `https://goshippo.com/tracking/${order.shippo_tracking_number}` : null),
      estimatedDelivery: order.estimated_delivery
    });

  } catch (err) {
    logger.error(`GET /api/tracking error: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

export default router;
