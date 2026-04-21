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
              carrier, amazon_fulfillment_id, customer_email, country, shippo_order_id,
              shipping_first_name, shipping_last_name, shipping_address1, shipping_city,
              subtotal, shipping_cost, tax, total
       FROM orders 
       WHERE fulfillment_status NOT IN ('delivered', 'cancelled', 'returned', 'error')
       AND (payment_status = 'paid' OR payment_status = 'refunded_pending')`
    );

    for (const order of orders) {
      try {
        if (order.country === 'US' && order.amazon_fulfillment_id) {
           // EDGE CASE: Skip mock fulfillment IDs used in testing/dev to avoid SP-API 400 errors
           if (order.amazon_fulfillment_id.startsWith('MOCK-') || order.amazon_fulfillment_id.startsWith('FAKE-')) {
             logger.debug(`Poller: Skipping mock/fake fulfillment ID ${order.amazon_fulfillment_id} for order ${order.order_number}`);
             continue;
           }
           const update = await mcfService.getFulfillmentOrder(order.amazon_fulfillment_id);
           await processMCFUpdate(order, update);
        } else if (order.country === 'CA') {
           if (order.tracking_number && order.carrier) {
             const status = await shippoService.getTrackingStatus(order.carrier, order.tracking_number);
             await processShippoUpdate(order, status);
           } else if (order.shippo_order_id) {
             const shippoOrder = await shippoService.getOrder(order.shippo_order_id);
             await syncShippoOrder(order, shippoOrder);
           }
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
    // FIX: mcfService.getFulfillmentOrder returns 'primaryTracking', not 'primaryTrackingNumber'
    const trackingNo = update.primaryTracking || order.tracking_number;
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
        
        if (newStatus === 'shipped' && order.fulfillment_status !== 'shipped') {
            await emailService.sendOrderShippedEmail(order, { 
                trackingNumber: order.tracking_number, 
                carrier: order.carrier,
                trackingUrl: status.tracking_url_provider
            }).catch(e => logger.error(`Shippo Shipped Email Fail [${order.order_number}]: ${e.message}`));
        }
        
        if (newStatus === 'delivered' && order.fulfillment_status !== 'delivered') {
            await emailService.sendOrderDeliveredEmail(order).catch(e => logger.error(`Shippo Delivered Email Fail [${order.order_number}]: ${e.message}`));
        }
    }
}

async function syncShippoOrder(order, shippoOrder) {
    // Check if there's a successful transaction with a tracking number
    const transaction = (shippoOrder.transactions || []).find(t => t.status === 'SUCCESS' && t.tracking_number);
    
    if (transaction) {
        logger.info(`Poller: Shippo order ${order.order_number} now has tracking: ${transaction.tracking_number}`);
        
        const trackingNo = transaction.tracking_number;
        const carrier = transaction.provider;
        const labelUrl = transaction.label_url;
        
        await db.execute(
            `UPDATE orders SET 
                fulfillment_status = 'shipped', 
                tracking_number = ?, 
                carrier = ?, 
                shippo_label_url = ?, 
                updated_at = NOW() 
             WHERE id = ?`,
            [trackingNo, carrier, labelUrl, order.id]
        );

        // Send shipped email immediately
        await emailService.sendOrderShippedEmail(order, { 
            trackingNumber: trackingNo, 
            carrier: carrier,
            trackingUrl: transaction.tracking_url_provider
        }).catch(e => logger.error(`Shippo Shipped Email Fail (Sync) [${order.order_number}]: ${e.message}`));
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
