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
    
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Find pending orders older than 20 minutes
        // We use created_at since 'pending' orders are rarely updated until they move to 'paid'
        const [abandonedOrders] = await connection.execute(
            `SELECT id, order_number FROM orders 
             WHERE status = 'pending' 
             AND created_at < DATE_SUB(NOW(), INTERVAL 20 MINUTE)`
        );

        if (abandonedOrders.length === 0) {
            logger.info('No abandoned orders found for stock recovery.');
            await connection.rollback();
            return;
        }

        logger.info(`Found ${abandonedOrders.length} abandoned orders. Recovering stock...`);

        for (const order of abandonedOrders) {
            // Get items for this order
            const [items] = await connection.execute(
                'SELECT product_id, quantity FROM order_items WHERE order_id = ?',
                [order.id]
            );

            for (const item of items) {
                // Restore stock atomically
                await Product.restoreStock(item.product_id, item.quantity, connection);
            }

            // Mark order as cancelled/failed due to timeout
            await connection.execute(
                "UPDATE orders SET status = 'cancelled', payment_status = 'failed', notes = CONCAT(COALESCE(notes,''), ' [System: Stock recovered due to inactivity]') WHERE id = ?",
                [order.id]
            );
            
            logger.info(`Recovered stock for abandoned order ${order.order_number}`);
        }

        await connection.commit();
        logger.info('Stock recovery job completed successfully.');
    } catch (err) {
        await connection.rollback();
        logger.error(`Stock recovery job failed: ${err.message}`);
    } finally {
        connection.release();
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
