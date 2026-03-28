import express from 'express';
import axios from 'axios';
import db from '../config/database.js';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import { fulfillOrder } from '../services/fulfillmentService.js';
import logger from '../utils/logger.js';
import { optionalAuth } from '../middleware/auth.js';

const router = express.Router();

const PAYPAL_API = process.env.PAYPAL_ENV === 'production' 
  ? 'https://api-m.paypal.com' 
  : 'https://api-m.sandbox.paypal.com';

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
 * Helper to get proper Frontend URL (handles comma-separated list in .env)
 */
function getBaseUrl(req) {
  if (req.headers.origin) return req.headers.origin;
  const firstUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0];
  return firstUrl;
}

/**
 * POST /api/payment/create-order
 * 1. Validates cart & prices server-side
 * 2. Deducts stock & creates internal order in 'pending' status
 * 3. Initiates PayPal order linked to internal order number
 */
router.post('/create-order', optionalAuth, async (req, res) => {
  try {
    const { country, currency, items, shipping, shippingCost, subtotal, tax, total, email, shippingSpeed } = req.body;
    
    // 1. Server-side validation (Price & Stock)
    const validation = await Product.validateCartItems(items, country);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: validation.errors.join(', ') });
    }

    // 2. Create Internal Order (Status: Pending, Payment: Pending)
    // This atomically deducts stock via Order.createOrder
    let internalOrder;
    try {
      internalOrder = await Order.createOrder({
        customerId: req.user?.userId || req.user?.id || null, // Handle both token formats
        country,
        items: validation.items,
        shipping,
        shippingSpeed: shippingSpeed || 'standard',
        paymentMethod: 'paypal',
        paymentStatus: 'pending',
        subtotal: parseFloat(subtotal),
        tax: parseFloat(tax || 0),
        shippingCost: parseFloat(shippingCost || 0),
        total: parseFloat(total),
        currency: currency || (country === 'CA' ? 'CAD' : 'USD'),
        customer_email: email,
        notes: 'Checkout initiated via PayPal'
      });
      logger.info(`Internal order ${internalOrder.order_number} created for ${email}`);
    } catch (orderErr) {
      logger.error(`Failed to pre-create order: ${orderErr.message}`);
      return res.status(500).json({ success: false, message: 'Failed to initiate order. Inventory may be insufficient.' });
    }

    // 3. Create PayPal Order
    const accessToken = await getPayPalAccessToken();
    const frontendBase = getBaseUrl(req);
    
    const paypalOrder = {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: internalOrder.order_number, // Link internal order# to PayPal
        amount: {
          currency_code: internalOrder.currency,
          value: parseFloat(total).toFixed(2),
          breakdown: {
            item_total: { currency_code: internalOrder.currency, value: parseFloat(subtotal).toFixed(2) },
            shipping: { currency_code: internalOrder.currency, value: parseFloat(shippingCost || 0).toFixed(2) },
            tax_total: { currency_code: internalOrder.currency, value: parseFloat(tax || 0).toFixed(2) }
          }
        },
        shipping: {
          name: { full_name: `${shipping.firstName} ${shipping.lastName}` },
          address: {
            address_line_1: shipping.address1,
            address_line_2: shipping.address2 || '',
            admin_area_2: shipping.city,
            admin_area_1: shipping.state || shipping.province,
            postal_code: shipping.zip || shipping.postalCode,
            country_code: country === 'CA' ? 'CA' : 'US'
          }
        }
      }],
      application_context: {
        return_url: `${frontendBase}/payment-success?orderId=${internalOrder.id}`,
        cancel_url: `${frontendBase}/checkout?cancelledOrder=${internalOrder.id}`,
        shipping_preference: 'SET_PROVIDED_ADDRESS',
        user_action: 'PAY_NOW'
      }
    };

    const response = await axios({
      url: `${PAYPAL_API}/v2/checkout/orders`,
      method: 'post',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      data: paypalOrder,
    });

    const paypalOrderId = response.data.id;

    // 4. Update Internal Order with the PayPal Reference
    await Order.updateOrder(internalOrder.id, {
      payment_reference: paypalOrderId,
      notes: `PayPal Order Created. ID: ${paypalOrderId}`
    });

    res.json({
      success: true,
      paypalOrderId: paypalOrderId,
      internalOrderId: internalOrder.id,
      orderNumber: internalOrder.order_number,
      links: response.data.links
    });

  } catch (err) {
    logger.error(`PayPal Create Order Error: ${err.message}`, { 
      data: err.response?.data,
      body: req.body 
    });
    res.status(500).json({ success: false, message: 'Failed to create PayPal order' });
  }
});

/**
 * POST /api/payment/capture
 * 1. Checks if order already paid (Idempotency)
 * 2. Captures payment from PayPal
 * 3. Finalizes internal order
 */
router.post('/capture', async (req, res) => {
  try {
    const { paypalOrderId } = req.body;
    if (!paypalOrderId) throw new Error('paypalOrderId is required');

    // 1. Find the internal order by its PayPal reference
    const [orders] = await db.query('SELECT * FROM orders WHERE payment_reference = ?', [paypalOrderId]);
    if (!orders.length) {
      return res.status(404).json({ success: false, message: 'Order not found for this payment reference.' });
    }
    const order = orders[0];

    // 2. Idempotency: Check if already processed
    if (order.payment_status === 'paid') {
      logger.info(`Capture already completed for PayPal ID ${paypalOrderId}`);
      return res.json({
        success: true,
        alreadyProcessed: true,
        order: { id: order.id, orderNumber: order.order_number, total: order.total }
      });
    }

    const accessToken = await getPayPalAccessToken();

    // 3. Capture Payment
    const captureResponse = await axios({
      url: `${PAYPAL_API}/v2/checkout/orders/${paypalOrderId}/capture`,
      method: 'post',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      }
    });

    if (captureResponse.data.status !== 'COMPLETED') {
      throw new Error(`PayPal payment NOT completed (Status: ${captureResponse.data.status})`);
    }

    const captureMeta = captureResponse.data.purchase_units[0].payments.captures[0];
    const captureId = captureMeta.id;
    const captureAmount = parseFloat(captureMeta.amount.value);

    // 4. Double check amount matches internal order
    if (Math.abs(captureAmount - parseFloat(order.total)) > 0.01) {
      logger.error(`CRITICAL: Amount mismatch on capture! PayPal: ${captureAmount}, Internal Order ${order.order_number}: ${order.total}`);
      await Order.updateOrder(order.id, { 
        payment_status: 'flagged_mismatch', 
        notes: `CRITICAL: Mismatched capture. Recieved ${captureAmount}, expected ${order.total}. ID: ${captureId}`
      });
      return res.status(400).json({ success: false, message: 'Payment amount mismatch. Order flagged for review.' });
    }

    // 5. Success - Finalize internal order
    await Order.updatePaymentStatus(order.id, {
      paymentStatus: 'paid',
      paymentReference: captureId, // Update to actual Capture ID
      paymentMethod: 'paypal'
    });

    // 6. Async fulfillment trigger
    fulfillOrder(order.id).catch(err => logger.error(`Background fulfillment error [${order.id}]: ${err.message}`));

    res.json({
      success: true,
      order: {
        id: order.id,
        orderNumber: order.order_number,
        total: order.total,
        currency: order.currency
      }
    });

  } catch (err) {
    const errorMsg = err.response?.data?.message || err.message;
    logger.error(`PayPal Capture Error: ${errorMsg}`);
    res.status(500).json({ success: false, message: `Payment failed: ${errorMsg}` });
  }
});

/**
 * POST /api/payment/cancel-order
 * Restores stock and marks order as cancelled if user backs out of PayPal
 */
router.post('/cancel-order', async (req, res) => {
  try {
    const { orderId } = req.body;
    const [rows] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Order not found' });
    
    const order = rows[0];
    if (order.status !== 'pending' || order.payment_status === 'paid') {
      return res.json({ success: true, message: 'Order cannot be cancelled in current state' });
    }

    // Get items to restore stock
    const [items] = await db.query('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
    
    // Restore Stock & Delete/Cancel Order
    await Product.restoreStock(items);
    await Order.updateOrder(orderId, {
      status: 'cancelled',
      payment_status: 'cancelled',
      notes: 'Customer cancelled at PayPal checkout'
    });

    logger.info(`Customer cancelled checkout - Order ${order.order_number} marked cancelled, stock restored`);
    res.json({ success: true, message: 'Checkout cancelled, stock restored.' });
  } catch (err) {
    logger.error(`Payment Cancel Error: ${err.message}`);
    res.status(500).json({ success: false, message: 'Internal error during cancellation' });
  }
});

export default router;
