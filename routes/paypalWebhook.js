import express from 'express';
import axios from 'axios';
import db from '../config/database.js';
import Order from '../models/Order.js';
import { fulfillOrder } from '../services/fulfillmentService.js';
import logger from '../utils/logger.js';

const router = express.Router();

const PAYPAL_API = 'https://api-m.paypal.com';

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
  });
  return response.data.access_token;
}

/**
 * POST /api/webhooks/paypal
 * Main entry point for PayPal Webhook Events
 */
router.post('/', async (req, res) => {
  let event;
  try {
    event = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
  } catch (parseErr) {
    logger.error('Failed to parse PayPal webhook body', { error: parseErr.message });
    return res.status(400).send('Invalid JSON');
  }

  const eventType = event.event_type;
  
  logger.info(`PayPal Webhook Received: ${eventType}`, { id: event.id });

  // Acknowledge receipt immediately as per PayPal best practices
  res.status(200).send('Webhook Received');

  try {
    // 1. Verify Webhook Signature (IMPORTANT for Production)
    // Normally we'd use PayPal's signature verification API here.
    // Simplifying for now but logging every attempt.
    
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
        await handlePaymentFailure(event.resource);
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

  logger.info(`Webhook: Auto-capturing approved order ${order.order_number} (PayPal ID: ${paypalOrderId})`);
  
  try {
    const accessToken = await getPayPalAccessToken();
    const captureResponse = await axios({
      url: `${PAYPAL_API}/v2/checkout/orders/${paypalOrderId}/capture`,
      method: 'post',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      }
    });

    if (captureResponse.data.status === 'COMPLETED') {
      const captureMeta = captureResponse.data.purchase_units[0].payments.captures[0];
      await Order.updatePaymentStatus(order.id, {
        paymentStatus: 'paid',
        paymentReference: captureMeta.id,
        paymentMethod: 'paypal'
      });
      
      // Trigger Fulfillment
      fulfillOrder(order.id).catch(err => logger.error(`Webhook fulfillment trigger error: ${err.message}`));
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
  // Capture resource usually has the order ID in supplementary_data or custom_id
  const paypalOrderId = captureResource.custom_id || captureResource.supplementary_data?.related_ids?.order_id;
  if (!paypalOrderId) return;

  const [orders] = await db.query('SELECT * FROM orders WHERE payment_reference = ?', [paypalOrderId]);
  if (orders.length && orders[0].payment_status !== 'paid') {
     await Order.updatePaymentStatus(orders[0].id, {
        paymentStatus: 'paid',
        paymentReference: captureResource.id,
        paymentMethod: 'paypal'
      });
      fulfillOrder(orders[0].id).catch(err => logger.error(`Webhook fulfillment trigger error: ${err.message}`));
      logger.info(`Webhook: Order ${orders[0].order_number} synced as PAID via CAPTURE.COMPLETED webhook.`);
  }
}

/**
 * Handle Payment Failures
 */
async function handlePaymentFailure(resource) {
    // Logic to mark order as failed and potentially notify admin/customer
    logger.error('PayPal Payment failure detected via webhook', { resource });
}

export default router;
