import Bull from 'bull';
import db from '../config/database.js';
import * as mcfService from '../services/mcfService.js';
import * as shippoService from '../services/shippoService.js';
import * as emailService from '../services/emailService.js';
import logger from '../utils/logger.js';

// ── Queue setup ───────────────────────────────────────────────────────────────
const redisConfig = {
  redis: {
    host:     process.env.REDIS_HOST     || '127.0.0.1',
    port:     parseInt(process.env.REDIS_PORT || '6379'),
    username: process.env.REDIS_USER     || 'default',
    password: process.env.REDIS_PASSWORD || undefined
  }
};

export const trackingQueue = new Bull('tracking-poller', redisConfig);

// ── Polling logic ─────────────────────────────────────────────────────────────
async function pollOrderNow(orderId) {
  try {
    const [orders] = await db.execute(
      `SELECT o.id, o.order_number, o.fulfillment_status, o.tracking_number, 
              o.carrier, o.amazon_fulfillment_id, o.shipping_first_name, o.shipping_last_name, 
              o.customer_email, o.country, o.mcf_tracking_ids
       FROM orders o WHERE o.id = ?`, [orderId]
    );

    if (!orders.length) return;
    const order = orders[0];

    // US (Amazon MCF)
    if (order.country === 'US' && order.amazon_fulfillment_id) {
       const update = await mcfService.getFulfillmentOrder(order.amazon_fulfillment_id);
       await processMCFUpdate(order, update);
    } 
    // Canada (Shippo)
    else if (order.country === 'CA' && order.tracking_number && order.carrier) {
       const status = await shippoService.getTrackingStatus(order.carrier, order.tracking_number);
       await processShippoUpdate(order, status);
    }
  } catch (err) {
    logger.error(`Poller: Error checking order ${orderId}: ${err.message}`);
  }
}

async function processMCFUpdate(order, update) {
    // Map Amazon status to our statuses: RECEIVED, PLANNING, PROCESSING, SHIPPED, DELIVERED, CANCELLED, UNFULFILLABLE
    const statusMap = {
        'RECEIVED': 'processing',
        'PLANNING': 'processing',
        'PROCESSING': 'processing',
        'SHIPPED': 'shipped',
        'DELIVERED': 'delivered',
        'CANCELLED': 'cancelled',
        'UNFULFILLABLE': 'error'
    };

    const newStatus = statusMap[update.status] || order.fulfillment_status?.toLowerCase();
    const trackingNo = update.primaryTrackingNumber || order.tracking_number;
    const carrier = update.primaryCarrier || order.carrier;
    const allTrackingJson = JSON.stringify(update.tracking);

    if (newStatus !== order.fulfillment_status || trackingNo !== order.tracking_number || allTrackingJson !== JSON.stringify(order.mcf_tracking_ids)) {
        await db.execute(
            `UPDATE orders SET fulfillment_status = ?, tracking_number = ?, carrier = ?, mcf_tracking_ids = ?, updated_at = NOW() WHERE id = ?`,
            [newStatus, trackingNo, carrier, allTrackingJson, order.id]
        );

        // SHIPMENT TRIGGER
        if (newStatus === 'shipped' && (order.fulfillment_status || '').toLowerCase() !== 'shipped' && trackingNo) {
            await emailService.sendOrderShippedEmail(order, { 
                trackingNumber: trackingNo, 
                carrier,
                estimatedDelivery: update.estimatedDelivery
            });
        }

        // DELIVERY TRIGGER (New for US orders)
        if (newStatus === 'delivered' && (order.fulfillment_status || '').toLowerCase() !== 'delivered') {
            await emailService.sendOrderDeliveredEmail(order);
        }

        // ERROR ALERT (If order becomes unfulfillable after submission)
        if (newStatus === 'error' && (order.fulfillment_status || '').toLowerCase() !== 'error') {
            await emailService.sendFulfillmentErrorAlert(order, new Error('Amazon reported this order as UNFULFILLABLE.'));
        }
    }
}

async function processShippoUpdate(order, status) {
    // Map Shippo status: PRE_TRANSIT, TRANSIT, DELIVERED, RETURNED, FAILURE, UNKNOWN
    const statusMap = {
        'PRE_TRANSIT': 'shipped',
        'TRANSIT': 'shipped',
        'DELIVERED': 'delivered',
        'RETURNED': 'returned',
        'FAILURE': 'error'
    };

    const newStatus = statusMap[status.status?.toUpperCase()] || order.fulfillment_status?.toLowerCase();
    if (newStatus !== order.fulfillment_status?.toLowerCase()) {
        await db.execute(
            `UPDATE orders SET fulfillment_status = ?, updated_at = NOW() WHERE id = ?`,
            [newStatus, order.id]
        );
        
        // Notify user on delivery
        if (newStatus === 'DELIVERED') {
            await emailService.sendOrderDeliveredEmail(order);
        }
    }
}

// ── Queue Processing ──────────────────────────────────────────────────────────
trackingQueue.process('global-poller', async (job) => {
    logger.info('Poller: Running global check on active orders...');
    try {
        const [orders] = await db.execute(
            `SELECT id FROM orders WHERE fulfillment_status NOT IN ('DELIVERED', 'CANCELLED', 'RETURNED', 'ERROR')`
        );
        
        for (const order of orders) {
            await trackingQueue.add('poll-single-order', { orderId: order.id });
        }
        
        logger.info(`Poller: Global check complete. Queued ${orders.length} orders for tracking.`);
        return { queued: orders.length };
    } catch (err) {
        logger.error(`Poller: Global check failed: ${err.message}`);
        throw err;
    }
});

trackingQueue.process('poll-single-order', async (job) => {
    const { orderId } = job.data;
    if (!orderId) {
        logger.warn('Poller: Received poll-single-order job without orderId');
        return;
    }
    await pollOrderNow(orderId);
});

// Fallback for unnamed jobs (if any)
trackingQueue.process(async (job) => {
    if (job.name !== 'global-poller' && job.name !== 'poll-single-order') {
        const { orderId } = job.data;
        if (orderId) {
            await pollOrderNow(orderId);
        }
    }
});

export async function startPolling() {
    // Clear old repeatable jobs to avoid duplicates or orphaned jobs
    const repeatableJobs = await trackingQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
        await trackingQueue.removeRepeatableByKey(job.key);
    }

    await trackingQueue.add('global-poller', {}, { 
        repeat: { cron: '*/15 * * * *' }, // Every 15 mins
        removeOnComplete: 10,
        jobId: 'global-poller'
    });
    logger.info('Background Poller: Scheduled for every 15 minutes.');
}

export async function stop() {
    await trackingQueue.close();
}

export default { startPolling, pollOrderNow, trackingQueue, stop };
