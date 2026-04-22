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
    // ALSO find orders that are 'paid' but fulfillment_status is still 'pending' for more than 5 minutes
    // (This covers background task failures or crashes during checkout)
    const [orders] = await db.execute(
      `SELECT id, order_number, country, retry_count, last_retry_at 
       FROM orders 
       WHERE (
         (fulfillment_status = 'fulfillment_error' AND retry_count < ?) 
         OR 
         (fulfillment_status = 'pending' AND updated_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE))
       )
       AND payment_status = 'paid'`,
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

        // If we are about to start the LAST retry and it's already at MAX_RETRIES, 
        // we actually want to catch the error and cancel it if it fails this time.
        // Wait, the query already filters by retry_count < MAX_RETRIES.
        
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
        
        // Save fulfillment error to order for diagnostic emails
        try {
          await db.execute(
            'UPDATE orders SET fulfillment_error = ? WHERE id = ?',
            [err.message?.substring(0, 500) || 'Unknown fulfillment error', order.id]
          );
        } catch (_) { /* Non-critical */ }

        // If we just hit the MAX_RETRIES (retry_count was updated above), mark as cancelled
        if (order.retry_count + 1 >= MAX_RETRIES) {
          logger.warn(`Background Job: Order ${order.order_number} reached MAX_RETRIES (${MAX_RETRIES}). Cancelling order and restoring stock.`);
          
          try {
            // Use our new consolidated restoreStock logic
            const Order = (await import('../models/Order.js')).default;
            await Order.updateOrderStatus(order.id, 'cancelled', `Fulfillment retries exhausted (${MAX_RETRIES}). Final error: ${err.message}`);
            await Order.updateFulfillmentStatus(order.id, 'cancelled');
            await Order.restoreStock(order.id);
            
            logger.info(`Background Job: Order ${order.order_number} auto-cancelled successfully.`);

            // Send critical escalation email to admin
            try {
              const emailService = (await import('../services/emailService.js')).default;
              const cancelledOrder = await Order.findById(order.id);
              if (cancelledOrder) {
                await emailService.sendRetryExhaustedAlert(cancelledOrder);
                logger.info(`Background Job: Retry exhausted alert sent for ${order.order_number}`);
              }
            } catch (emailErr) {
              logger.error(`Background Job: Failed to send retry exhausted alert for ${order.order_number}: ${emailErr.message}`);
            }
          } catch (cancelErr) {
            logger.error(`Background Job: Failed to auto-cancel order ${order.id}: ${cancelErr.message}`);
          }
        }
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
