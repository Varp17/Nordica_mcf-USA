import db from '../config/database.js';
import fulfillmentService from '../services/fulfillmentService.js';
import logger from '../utils/logger.js';

const POLL_INTERVAL_MS = 30 * 60 * 1000; // Look every 30 minutes
let _intervalId = null;

const MAX_RETRIES = 3;

/**
 * Scan for orders that failed fulfillment and retry them if they haven't exceeded max retries.
 */
export async function retryFailedFulfillments() {
  try {
    logger.info('Background Job: Checking for failed fulfillments to retry...');

    // Find orders with fulfillment_error, payment_status paid, and retry_count < MAX_RETRIES
    const [orders] = await db.execute(
      `SELECT id, order_number, country, retry_count, last_retry_at 
       FROM orders 
       WHERE fulfillment_status = 'fulfillment_error' 
       AND payment_status = 'paid' 
       AND retry_count < ?`,
      [MAX_RETRIES]
    );

    if (orders.length === 0) {
      logger.info('Background Job: No failed fulfillments to retry.');
      return;
    }

    for (const order of orders) {
      try {
        // Simple exponential backoff: 30m, 2h, 8h
        const backoffMinutes = Math.pow(4, order.retry_count) * 30; // 0->30, 1->120, 2->480
        const now = new Date();
        const lastRetry = order.last_retry_at ? new Date(order.last_retry_at) : new Date(0);
        const diffMinutes = (now - lastRetry) / (1000 * 60);

        if (diffMinutes < backoffMinutes) {
          logger.info(`Background Job: Skipping retry for order ${order.order_number} (Backoff for retry ${order.retry_count + 1} not met: ${Math.round(diffMinutes)}/${backoffMinutes} min)`);
          continue;
        }

        logger.info(`Background Job: Retrying fulfillment for order ${order.order_number} (Attempt ${order.retry_count + 1})`);

        // Update retry stats BEFORE attempting to prevent double-starts in next cycle if current cycle is slow
        await db.execute(
          'UPDATE orders SET retry_count = retry_count + 1, last_retry_at = NOW() WHERE id = ?',
          [order.id]
        );

        // Attempt fulfillment
        await fulfillmentService.fulfillOrder(order.id);
        
        logger.info(`Background Job: Successfully retried fulfillment for ${order.order_number}`);
      } catch (err) {
        logger.error(`Background Job: Retry failed for order ${order.order_number}: ${err.message}`);
        // Status is already 'fulfillment_error', so just leave it for next pass
      }
    }
  } catch (err) {
    logger.error(`Background Job: Global failed fulfillment retry scan failed: ${err.message}`);
  }
}

export function startRetryJob() {
  if (_intervalId) return;
  // Run once on startup, then every interval
  retryFailedFulfillments();
  _intervalId = setInterval(retryFailedFulfillments, POLL_INTERVAL_MS);
  logger.info('Background Job (Fulfillment Retry): Started');
}

export function stop() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
}

export default { startRetryJob, stop, retryFailedFulfillments };
