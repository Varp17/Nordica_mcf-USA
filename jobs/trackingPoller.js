import db from '../config/database.js';
import * as mcfService from '../services/mcfService.js';
import shippoService from '../services/shippoService.js';
import * as emailService from '../services/emailService.js';
import logger from '../utils/logger.js';

const POLL_INTERVAL_MS = 15 * 60 * 1000;
let _intervalId = null;

export async function pollAllActiveOrders() {
  try {
    const [orders] = await db.execute(
      `SELECT id, order_number, fulfillment_status, tracking_number, 
              carrier, amazon_fulfillment_id, customer_email, country
       FROM orders 
       WHERE fulfillment_status NOT IN ('delivered', 'cancelled', 'returned', 'error')
       AND (payment_status = 'paid' OR payment_status = 'refunded_pending')`
    );

    for (const order of orders) {
      try {
        if (order.country === 'US' && order.amazon_fulfillment_id) {
           const update = await mcfService.getFulfillmentOrder(order.amazon_fulfillment_id);
           await processMCFUpdate(order, update);
        } else if (order.country === 'CA' && order.tracking_number && order.carrier) {
           const status = await shippoService.getTrackingStatus(order.carrier, order.tracking_number);
           await processShippoUpdate(order, status);
        }
      } catch (err) {
        logger.error(`Poller: Failed to poll order ${order.order_number}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`Poller: Global scan failed: ${err.message}`);
  }
}

async function processMCFUpdate(order, update) {
    const statusMap = {
        'RECEIVED': 'processing', 'PLANNING': 'processing', 'PROCESSING': 'processing',
        'SHIPPED': 'shipped', 'DELIVERED': 'delivered', 'CANCELLED': 'cancelled', 'UNFULFILLABLE': 'error'
    };
    const newStatus = statusMap[update.status] || order.fulfillment_status?.toLowerCase();
    const trackingNo = update.primaryTrackingNumber || order.tracking_number;
    const carrier = update.primaryCarrier || order.carrier;

    if (newStatus !== order.fulfillment_status || trackingNo !== order.tracking_number) {
        await db.execute(
            `UPDATE orders SET fulfillment_status = ?, tracking_number = ?, carrier = ?, updated_at = NOW() WHERE id = ?`,
            [newStatus, trackingNo, carrier, order.id]
        );
        if (newStatus === 'shipped' && order.fulfillment_status !== 'shipped' && trackingNo) {
            await emailService.sendOrderShippedEmail(order, { trackingNumber: trackingNo, carrier, estimatedDelivery: update.estimatedDelivery || '3-5 business days' }).catch(e => {});
        }
        if (newStatus === 'delivered' && order.fulfillment_status !== 'delivered') {
            await emailService.sendOrderDeliveredEmail(order).catch(e => {});
        }
    }
}

async function processShippoUpdate(order, status) {
    const statusMap = { 'PRE_TRANSIT': 'shipped', 'TRANSIT': 'shipped', 'DELIVERED': 'delivered', 'RETURNED': 'returned', 'FAILURE': 'error' };
    const newStatus = statusMap[status.status?.toUpperCase()] || order.fulfillment_status?.toLowerCase();
    if (newStatus !== order.fulfillment_status?.toLowerCase()) {
        await db.execute(`UPDATE orders SET fulfillment_status = ?, updated_at = NOW() WHERE id = ?`, [newStatus, order.id]);
        if (newStatus === 'delivered') await emailService.sendOrderDeliveredEmail(order).catch(e => {});
    }
}

export function startPolling() {
  if (_intervalId) return;
  _intervalId = setInterval(pollAllActiveOrders, POLL_INTERVAL_MS);
  logger.info('Background Poller: Started');
}

export function stop() {
  if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
}

export default { startPolling, stop, pollAllActiveOrders };
