import express from 'express';
import db from '../config/database.js';
import logger from '../utils/logger.js';
import { getTrackingStatus } from '../services/shippoService.js';

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
    const carrier = order.shippo_carrier || order.carrier;
    const trackingNumber = order.shippo_tracking_number || order.tracking_number;

    let liveTracking = null;
    if (trackingNumber && carrier) {
      try {
        liveTracking = await getTrackingStatus(carrier.toLowerCase(), trackingNumber);
      } catch (err) {
        logger.warn(`Live tracking fetch failed for ${carrier}/${trackingNumber}: ${err.message}`);
      }
    }

    // Return tracking info
    return res.json({
      success: true,
      orderId: order.id,
      orderNumber: order.order_number,
      fulfillmentStatus: order.fulfillment_status,
      carrier,
      trackingNumber,
      trackingUrl: order.tracking_url || (trackingNumber ? `https://goshippo.com/tracking/${trackingNumber}` : null),
      estimatedDelivery: order.estimated_delivery,
      // Shippo Live Data
      status: liveTracking?.status || order.fulfillment_status,
      tracking: liveTracking ? {
        status: liveTracking.status,
        statusDetails: liveTracking.tracking_status?.status_details,
        statusDate: liveTracking.tracking_status?.status_date,
        location: liveTracking.tracking_status?.location,
        events: (liveTracking.tracking_history || []).map(h => ({
          status: h.status,
          label: h.status_details,
          time: h.status_date,
          location: h.location ? `${h.location.city}, ${h.location.state} ${h.location.country}` : null,
          description: h.status_details
        }))
      } : null
    });

  } catch (err) {
    logger.error(`GET /api/tracking error: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

export default router;
