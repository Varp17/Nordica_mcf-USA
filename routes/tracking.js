import express from 'express';
import db from '../config/database.js';
import logger from '../utils/logger.js';
import shippoService from '../services/shippoService.js';

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

    // Look up order. Verify email if provided. 
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

    let liveStatus = null;
    let liveEvents = [];
    let liveTrackingUrl = order.tracking_url;

    // ── 1. SHIPPO TRACKING (Canada) ──────────────────────────────────────────
    if (order.country === 'CA' && trackingNumber && carrier) {
      try {
        const liveTracking = await shippoService.getTrackingStatus(carrier.toLowerCase(), trackingNumber);
        liveStatus = liveTracking.status;
        liveEvents = (liveTracking.tracking_history || []).map(h => ({
          status: h.status,
          label: h.status_details,
          time: h.status_date,
          location: h.location ? `${h.location.city}, ${h.location.state} ${h.location.country}` : null,
          description: h.status_details
        }));
        if (!liveTrackingUrl) liveTrackingUrl = `https://goshippo.com/tracking/${trackingNumber}`;
      } catch (err) {
        logger.warn(`Shippo live tracking failed for ${order.order_number}: ${err.message}`);
      }
    } 
    // ── 2. AMAZON MCF TRACKING (USA) ──────────────────────────────────────────
    else if (order.country === 'US' && (order.amazon_fulfillment_id || order.mcf_order_id)) {
      try {
        const mcfService = (await import('../services/mcfService.js')).default;
        const mcfRes = await mcfService.getFulfillmentOrder(order.amazon_fulfillment_id || order.mcf_order_id);
        
        liveStatus = mcfRes.status;
        if (mcfRes.tracking && mcfRes.tracking.length > 0) {
            liveEvents = mcfRes.tracking.map(t => ({
                status: t.status,
                label: t.status,
                time: t.estimatedArrival || new Date().toISOString(),
                location: t.carrierCode,
                description: `Package moving via ${t.carrierCode}. Tracking ID: ${t.trackingNumber}`
            }));
            
            if (!liveTrackingUrl && mcfRes.primaryTracking) {
                liveTrackingUrl = `https://www.amazon.com/progress-tracker/package-tracking/${mcfRes.primaryTracking}`;
            }
        }
      } catch (err) {
        logger.warn(`MCF live tracking failed for ${order.order_number}: ${err.message}`);
      }
    }

    return res.json({
      success: true,
      orderId: order.id,
      orderNumber: order.order_number,
      fulfillmentStatus: order.fulfillment_status,
      carrier: carrier || (order.country === 'US' ? 'Amazon Logistics' : null),
      trackingNumber,
      trackingUrl: liveTrackingUrl,
      estimatedDelivery: order.estimated_delivery,
      status: liveStatus || order.fulfillment_status,
      tracking: {
        status: liveStatus,
        events: liveEvents,
        trackingUrl: liveTrackingUrl
      }
    });

  } catch (err) {
    logger.error(`GET /api/tracking error: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

export default router;

