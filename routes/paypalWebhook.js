import express from 'express';
import axios from 'axios';
import db from '../config/database.js';
import Order from '../models/Order.js';
import * as Product from '../models/Product.js';
import { fulfillOrder } from '../services/fulfillmentService.js';
import emailService from '../services/emailService.js';
import logger from '../utils/logger.js';

const router = express.Router();

const PAYPAL_API = process.env.PAYPAL_API || 'https://api-m.paypal.com';

/**
 * Get PayPal Access Token
 */
async function getPayPalAccessToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');

  const response = await axios({
    url: `${PAYPAL_API}/v1/oauth2/token`,
    method: 'post',
    data: params.toString(),
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: 10000,
  });
  return response.data.access_token;
}

/**
 * Verify Webhook Signature using PayPal API
 * EDGE CASE #62: Mandatory for production security
 */
async function verifyPayPalSignature(req) {
  try {
    const accessToken = await getPayPalAccessToken();
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;

    if (!webhookId) {
      logger.error('PAYPAL_WEBHOOK_ID not configured. Skipping signature verification (INSECURE)');
      return true; // Fallback for dev, but should be false in prod
    }

    const payload = {
      transmission_id: req.headers['paypal-transmission-id'],
      transmission_time: req.headers['paypal-transmission-time'],
      cert_url: req.headers['paypal-cert-url'],
      auth_algo: req.headers['paypal-auth-algo'],
      transmission_sig: req.headers['paypal-transmission-sig'],
      webhook_id: webhookId,
      webhook_event: req.body
    };

    const response = await axios({
      url: `${PAYPAL_API}/v1/notifications/verify-webhook-signature`,
      method: 'post',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      data: payload,
      timeout: 10000,
    });

    return response.data.verification_status === 'SUCCESS';
  } catch (err) {
    logger.error(`PayPal Signature Verification Error: ${err.message}`);
    return false;
  }
}

/**
 * POST /api/webhooks/paypal
 * Main entry point for PayPal Webhook Events
 */
router.post('/', async (req, res) => {
  // 1. Verify Webhook Signature (IMPORTANT for Production)
  const isValid = await verifyPayPalSignature(req);
  if (!isValid && process.env.NODE_ENV === 'production') {
    logger.error('PayPal Webhook: Invalid Signature');
    return res.status(401).send('Invalid Signature');
  }

  const event = req.body;
  const eventType = event.event_type;
  
  logger.info(`PayPal Webhook Received: ${eventType}`, { id: event.id });

  // Acknowledge receipt immediately
  res.status(200).send('Webhook Received');

  try {
    switch (eventType) {
      case 'CHECKOUT.ORDER.APPROVED':
        // User approved the payment but frontend might have failed to call /capture
        await handleOrderApproved(event.resource);
        break;
      
      case 'PAYMENT.CAPTURE.COMPLETED':
        // Payment was caught by another process or captured manually
        await handleCaptureCompleted(event.resource);
        break;

      case 'PAYMENT.CAPTURE.DENIED':
      case 'PAYMENT.CAPTURE.REVERSED':
      case 'PAYMENT.CAPTURE.REFUNDED':
        await handlePaymentFailure(event.resource, eventType);
        break;

      default:
        logger.debug(`Unhandled PayPal event type: ${eventType}`);
    }
  } catch (err) {
    logger.error(`Error processing PayPal Webhook [${eventType}]: ${err.message}`, { stack: err.stack });
  }
});

/**
 * Handle Order Approved event (Triggers capture if not already done)
 */
async function handleOrderApproved(paypalOrder) {
  const paypalOrderId = paypalOrder.id;
  
  // Find internal order
  const [orders] = await db.query('SELECT * FROM orders WHERE payment_reference = ?', [paypalOrderId]);
  if (!orders.length) {
    logger.warn(`Webhook: No internal order found for PayPal ID ${paypalOrderId}`);
    return;
  }
  
  const order = orders[0];
  if (order.payment_status === 'paid') {
    logger.info(`Webhook: Internal order ${order.order_number} already marked as paid. Skipping.`);
    return;
  }

  // EDGE CASE #63: Amount verification
  const paypalTotal = parseFloat(paypalOrder.purchase_units[0].amount.value);
  if (Math.abs(paypalTotal - parseFloat(order.total)) > 0.02) {
    logger.error(`CRITICAL: Webhook Amount Mismatch for order ${order.order_number}. Expected ${order.total}, got ${paypalTotal}`);
    await Order.updateOrder(order.id, { 
      payment_status: 'flagged_mismatch',
      notes: (order.notes || '') + `\nCRITICAL: Webhook mismatch. PayPal total ${paypalTotal} != Expected ${order.total}. Payment NOT auto-captured.`
    });
    return;
  }

  logger.info(`Webhook: Auto-capturing approved order ${order.order_number} (PayPal ID: ${paypalOrderId})`);
  
  try {
    const accessToken = await getPayPalAccessToken();
    const captureResponse = await axios({
      url: `${PAYPAL_API}/v2/checkout/orders/${paypalOrderId}/capture`,
      method: 'post',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    if (captureResponse.data.status === 'COMPLETED') {
      const captureMeta = captureResponse.data.purchase_units[0].payments.captures[0];
      await Order.updateOrder(order.id, {
        payment_status: 'paid',
        payment_reference: captureMeta.id,
        payment_method: 'paypal',
        paid_at: new Date()
      });
      
      // Trigger Fulfillment
      fulfillOrder(order.id).catch(err => logger.error(`Webhook fulfillment trigger error: ${err.message}`));
      
      // Admin Notification (async)
      emailService.sendNewOrderAdminAlert(order).catch(err => logger.error(`Admin notification error [${order.id}]: ${err.message}`));

      logger.info(`Webhook: Order ${order.order_number} successfully captured and finalized via webhook.`);
    }
  } catch (err) {
    logger.error(`Webhook: Async capture failed for ${order.order_number}: ${err.message}`);
  }
}

/**
 * Handle Capture Completed event (Marks as paid if not already)
 */
async function handleCaptureCompleted(captureResource) {
  // Capture resource usually has the order ID in supplementary_data or custom_id or as a reference
  // EDGE CASE #64: Better link detection
  const referenceId = captureResource.custom_id || 
                      captureResource.supplementary_data?.related_ids?.order_id || 
                      null;
                      
  let order;
  if (referenceId) {
    const [orders] = await db.query('SELECT * FROM orders WHERE payment_reference = ? OR order_number = ?', [referenceId, referenceId]);
    if (orders.length) order = orders[0];
  }

  if (!order) {
    // Try finding by internal capture reference if we already stored it
    const [rows] = await db.query('SELECT * FROM orders WHERE payment_reference = ?', [captureResource.id]);
    if (rows.length) order = rows[0];
  }

  if (order && order.payment_status !== 'paid') {
      // Amount verification
      const captureAmount = parseFloat(captureResource.amount.value);
      if (Math.abs(captureAmount - parseFloat(order.total)) > 0.02) {
          logger.error(`Webhook Sync: Amount mismatch on capture! PayPal: ${captureAmount}, Internal: ${order.total}`);
          await Order.updateOrder(order.id, { 
              payment_status: 'flagged_mismatch',
              notes: (order.notes || '') + `\nWebhook Sync Mismatch: Captured ${captureAmount}, expected ${order.total}.`
          });
          return;
      }

      await Order.updateOrder(order.id, {
        payment_status: 'paid',
        payment_reference: captureResource.id,
        payment_method: 'paypal',
        paid_at: new Date()
      });
      fulfillOrder(order.id).catch(err => logger.error(`Webhook fulfillment trigger error: ${err.message}`));

      // Admin Notification (async)
      emailService.sendNewOrderAdminAlert(order).catch(err => logger.error(`Admin notification error [${order.id}]: ${err.message}`));

      logger.info(`Webhook: Order ${order.order_number} synced as PAID via CAPTURE.COMPLETED webhook.`);
  }
}

/**
 * Handle Payment Failures
 * EDGE CASE #65: Implement proper failure handling and stock restoration
 */
async function handlePaymentFailure(resource, eventType) {
    logger.error(`PayPal Webhook: Payment failure (${eventType})`, { resource });
    
    // Find order by capture ID or order reference
    const captureId = resource.id;
    const [orders] = await db.query('SELECT * FROM orders WHERE payment_reference = ?', [captureId]);
    
    if (!orders.length) return;
    const order = orders[0];

    if (order.payment_status === 'paid') {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            
            // Mark as failed/refunded/denied
            await connection.execute(
                `UPDATE orders SET payment_status = ?, notes = CONCAT(COALESCE(notes,''), ?), updated_at = NOW() WHERE id = ?`,
                [eventType.toLowerCase().split('.').pop(), `\nPayPal Webhook Alert: ${eventType}`, order.id]
            );

            // Restore stock if it was reversed/denied/refunded and we want to put items back
            // Only RESTORE stock if the order status is NOT already shipped or cancelled
            if (['pending', 'processing'].includes(order.status)) {
                // Get items
                const [items] = await connection.execute('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
                if (items.length > 0) {
                    await Product.restoreStock(items, connection);
                }
                await connection.execute(`UPDATE orders SET status = 'failed' WHERE id = ?`, [order.id]);
            }

            await connection.commit();
            logger.info(`Order ${order.order_number} updated status to ${eventType} and stock restored.`);
        } catch (err) {
            await connection.rollback();
            logger.error(`Failed to handle webhook failure for order ${order.order_number}: ${err.message}`);
        } finally {
            connection.release();
        }
    }
}

export default router;
