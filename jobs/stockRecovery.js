import db from '../config/database.js';
import * as Product from '../models/Product.js';
import logger from '../utils/logger.js';

/**
 * Stock Recovery Job
 * -------------------
 * This job finds 'pending' orders that have been inactive for more than 2 hours.
 * It restores the reserved stock to the products and marks the orders as 'cancelled'.
 * 
 * This covers the edge case where a customer goes to PayPal but closes their browser
 * without paying OR clicking 'Cancel'.
 */
async function recoverAbandonedStock() {
    logger.info('Running Stock Recovery Job...');
    
    try {
        // 1. Find pending orders older than 20 minutes
        // EDGE CASE #3: Exclude orders already marked as paid — a slow PayPal webhook might
        // have captured payment but not yet updated the status column.
        const [abandonedOrders] = await db.execute(
            `SELECT id, order_number FROM orders 
             WHERE status = 'pending' 
             AND payment_status NOT IN ('paid', 'flagged_mismatch')
             AND created_at < DATE_SUB(NOW(), INTERVAL 20 MINUTE)`
        );

        if (abandonedOrders.length === 0) {
            logger.info('No abandoned orders found for stock recovery.');
            return;
        }

        logger.info(`Found ${abandonedOrders.length} abandoned orders. Recovering stock...`);

        // EDGE CASE #2: Process each order independently so one failure
        // doesn't block stock recovery for all other orders.
        for (const order of abandonedOrders) {
            const connection = await db.getConnection();
            try {
                await connection.beginTransaction();

                // Double-check inside transaction that order is still pending & unpaid
                const [lockRows] = await connection.execute(
                    `SELECT id, status, payment_status FROM orders WHERE id = ? AND status = 'pending' AND payment_status NOT IN ('paid', 'flagged_mismatch') FOR UPDATE`,
                    [order.id]
                );

                if (lockRows.length === 0) {
                    // Order was captured/cancelled between our initial SELECT and now
                    logger.info(`Order ${order.order_number} no longer eligible for recovery — skipping.`);
                    await connection.rollback();
                    continue;
                }

                // Get items for this order
                const [items] = await connection.execute(
                    'SELECT product_id, product_variant_id, sku, quantity FROM order_items WHERE order_id = ?',
                    [order.id]
                );

                // EDGE CASE #1: restoreStock expects an ARRAY of item objects, not individual args.
                // Map items to the shape restoreStock expects.
                if (items.length > 0) {
                    const restoreItems = items.map(item => ({
                        product_id: item.product_id,
                        variantId: item.product_variant_id,
                        sku: item.sku,
                        quantity: item.quantity
                    }));
                    await Product.restoreStock(restoreItems, connection);
                }

                // Mark order as cancelled/failed due to timeout
                await connection.execute(
                    "UPDATE orders SET status = 'cancelled', payment_status = 'expired', fulfillment_status = 'cancelled', notes = CONCAT(COALESCE(notes,''), ' [System: Stock recovered due to checkout timeout]'), updated_at = NOW() WHERE id = ?",
                    [order.id]
                );

                await connection.commit();
                logger.info(`Recovered stock for abandoned order ${order.order_number}`);
            } catch (err) {
                await connection.rollback();
                logger.error(`Stock recovery failed for order ${order.order_number}: ${err.message}`);
            } finally {
                connection.release();
            }
        }

        logger.info('Stock recovery job completed successfully.');
    } catch (err) {
        logger.error(`Stock recovery job failed: ${err.message}`);
    }
}

let intervalId = null;

export default {
    start: (intervalMs = 300000) => { // Default to every 5 minutes
        if (intervalId) return;
        // Run immediately on start
        recoverAbandonedStock();
        // Then schedule
        intervalId = setInterval(recoverAbandonedStock, intervalMs);
        logger.info(`Stock recovery job scheduled every ${intervalMs / 1000 / 60} minutes.`);
    },
    stop: () => {
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
        }
    },
    runNow: recoverAbandonedStock
};
