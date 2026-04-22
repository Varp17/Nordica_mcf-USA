import db from '../config/database.js';
import emailService from '../services/emailService.js';
import logger from '../utils/logger.js';

/**
 * Fulfillment Monitor — Background Job
 * ─────────────────────────────────────
 * Runs every 30 minutes and catches orders that slipped through the cracks:
 *
 * 1. STALE ORDERS (6+ hours paid but not fulfilled)
 *    - Sends escalation email to admin with full order details
 *    - Only alerts ONCE per order (uses `stale_alerted_at` flag)
 *
 * 2. REPEATED FAILURE ESCALATION (retries exhausted)
 *    - Detects orders that hit MAX_RETRIES and are now cancelled
 *    - Sends a critical alert so admin can manually intervene
 *
 * 3. CA ORDERS STUCK IN SHIPPO (12+ hours without label)
 *    - Canadian orders that are `submitted_to_shippo` but no tracking number after 12h
 *    - Reminds admin to purchase the label
 */

const MONITOR_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const STALE_THRESHOLD_HOURS = 6;
const CA_STALE_THRESHOLD_HOURS = 12;

let _intervalId = null;

/**
 * Main monitor tick
 */
async function runMonitor() {
  try {
    logger.info('[FulfillmentMonitor] Running check cycle...');

    await checkStaleOrders();
    await checkExhaustedRetries();
    await checkStaleCaOrders();

    logger.info('[FulfillmentMonitor] Check cycle complete.');
  } catch (err) {
    logger.error(`[FulfillmentMonitor] Global error: ${err.message}`);
  }
}

/**
 * 1. STALE ORDERS — Paid but not fulfilled for 6+ hours
 *    Covers both US and CA orders.
 */
async function checkStaleOrders() {
  try {
    const [staleOrders] = await db.execute(
      `SELECT o.id, o.order_number, o.country, o.customer_email, o.total, o.currency,
              o.shipping_first_name, o.shipping_last_name, o.shipping_speed,
              o.fulfillment_status, o.fulfillment_error, o.paid_at, o.retry_count,
              o.shipping_city, o.shipping_state, o.shipping_province
       FROM orders o
       WHERE o.payment_status = 'paid'
         AND o.fulfillment_status IN ('pending', 'fulfillment_error', 'on_hold_verification')
         AND o.paid_at < DATE_SUB(NOW(), INTERVAL ? HOUR)
         AND o.stale_alerted_at IS NULL
         AND o.status != 'cancelled'
       ORDER BY o.paid_at ASC
       LIMIT 20`,
      [STALE_THRESHOLD_HOURS]
    );

    if (staleOrders.length === 0) return;

    logger.warn(`[FulfillmentMonitor] Found ${staleOrders.length} stale paid orders (${STALE_THRESHOLD_HOURS}h+)`);

    // Group by country for consolidated emails
    const usOrders = staleOrders.filter(o => (o.country || '').toUpperCase() === 'US');
    const caOrders = staleOrders.filter(o => (o.country || '').toUpperCase() === 'CA');

    if (usOrders.length > 0) {
      await emailService.sendStaleOrderAlert(usOrders, 'US');
    }
    if (caOrders.length > 0) {
      await emailService.sendStaleOrderAlert(caOrders, 'CA');
    }

    // Mark as alerted so we don't spam
    const ids = staleOrders.map(o => o.id);
    if (ids.length > 0) {
      await db.query(
        `UPDATE orders SET stale_alerted_at = NOW() WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      );
    }
  } catch (err) {
    logger.error(`[FulfillmentMonitor] Stale order check failed: ${err.message}`);
  }
}

/**
 * 2. EXHAUSTED RETRIES — Orders that hit MAX_RETRIES and got auto-cancelled
 *    These need immediate manual attention because the customer paid but we couldn't ship.
 */
async function checkExhaustedRetries() {
  try {
    const [exhaustedOrders] = await db.execute(
      `SELECT o.id, o.order_number, o.country, o.customer_email, o.total, o.currency,
              o.shipping_first_name, o.shipping_last_name,
              o.fulfillment_status, o.fulfillment_error, o.retry_count,
              o.paid_at, o.shipping_speed, o.notes,
              o.shipping_city, o.shipping_state, o.shipping_province
       FROM orders o
       WHERE o.payment_status = 'paid'
         AND o.status = 'cancelled'
         AND o.fulfillment_status = 'cancelled'
         AND o.retry_count >= 3
         AND o.exhausted_alerted_at IS NULL
       ORDER BY o.updated_at DESC
       LIMIT 10`
    );

    if (exhaustedOrders.length === 0) return;

    logger.warn(`[FulfillmentMonitor] Found ${exhaustedOrders.length} orders with exhausted retries`);

    for (const order of exhaustedOrders) {
      await emailService.sendRetryExhaustedAlert(order);
      await db.execute('UPDATE orders SET exhausted_alerted_at = NOW() WHERE id = ?', [order.id]);
    }
  } catch (err) {
    logger.error(`[FulfillmentMonitor] Exhausted retry check failed: ${err.message}`);
  }
}

/**
 * 3. STALE CA ORDERS — Submitted to Shippo but no label purchased after 12h
 *    Reminds admin to take action in the Shippo Dashboard.
 */
async function checkStaleCaOrders() {
  try {
    const [staleCa] = await db.execute(
      `SELECT o.id, o.order_number, o.customer_email, o.total, o.currency,
              o.shipping_first_name, o.shipping_last_name,
              o.fulfillment_status, o.paid_at, o.shipping_speed,
              o.shipping_city, o.shipping_state, o.shipping_province,
              o.shippo_order_id
       FROM orders o
       WHERE o.payment_status = 'paid'
         AND o.country = 'CA'
         AND o.fulfillment_status = 'submitted_to_shippo'
         AND o.shippo_tracking_number IS NULL
         AND o.paid_at < DATE_SUB(NOW(), INTERVAL ? HOUR)
         AND o.ca_label_reminder_at IS NULL
         AND o.status != 'cancelled'
       ORDER BY o.paid_at ASC
       LIMIT 10`,
      [CA_STALE_THRESHOLD_HOURS]
    );

    if (staleCa.length === 0) return;

    logger.warn(`[FulfillmentMonitor] Found ${staleCa.length} CA orders awaiting label purchase (${CA_STALE_THRESHOLD_HOURS}h+)`);

    await emailService.sendCaLabelReminderAlert(staleCa);

    const ids = staleCa.map(o => o.id);
    if (ids.length > 0) {
      await db.query(
        `UPDATE orders SET ca_label_reminder_at = NOW() WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      );
    }
  } catch (err) {
    logger.error(`[FulfillmentMonitor] CA stale order check failed: ${err.message}`);
  }
}

export function start() {
  if (_intervalId) return;
  // Delay first run by 2 minutes to let server fully boot
  setTimeout(() => {
    runMonitor();
    _intervalId = setInterval(runMonitor, MONITOR_INTERVAL_MS);
  }, 2 * 60 * 1000);
  logger.info('[FulfillmentMonitor] Scheduled (first run in 2 min, then every 30 min)');
}

export function stop() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
    logger.info('[FulfillmentMonitor] Stopped');
  }
}

export default { start, stop, runMonitor };
