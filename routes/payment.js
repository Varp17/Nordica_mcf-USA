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
 * POST /api/payment/create-order
 * Initiates a PayPal order
 */
router.post('/create-order', async (req, res) => {
  try {
    const { country, currency, items, shipping, shippingCost, subtotal, tax, total, email } = req.body;
    
    const accessToken = await getPayPalAccessToken();
    
    const nTotal = parseFloat(total);
    const nSubtotal = parseFloat(subtotal);
    const nShipping = parseFloat(shippingCost || 0);
    const nTax = parseFloat(tax || 0);

    const paypalOrder = {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: currency || (country === 'CA' ? 'CAD' : 'USD'),
          value: nTotal.toFixed(2),
          breakdown: {
            item_total: { currency_code: currency, value: nSubtotal.toFixed(2) },
            shipping: { currency_code: currency, value: nShipping.toFixed(2) },
            tax_total: { currency_code: currency, value: nTax.toFixed(2) }
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
        return_url: `${process.env.FRONTEND_URL}/payment-success`,
        cancel_url: `${process.env.FRONTEND_URL}/checkout`,
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

    res.json({
      success: true,
      paypalOrderId: response.data.id,
      links: response.data.links
    });
  } catch (err) {
    logger.error(`PayPal Create Order Error: ${err.message}`, { response: err.response?.data });
    res.status(500).json({ success: false, message: 'Failed to create PayPal order' });
  }
});

/**
 * POST /api/payment/capture
 * Captures the payment and creates the internal order
 */
router.post('/capture', optionalAuth, async (req, res) => {
  try {
    const { paypalOrderId, country, email, items, shipping, shippingSpeed, subtotal, tax, shippingCost, total, currency } = req.body;
    
    // 0. Validate items and prices server-side to prevent tampering
    const validation = await Product.validateCartItems(items, country);
    if (!validation.valid) {
      throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
    }

    const accessToken = await getPayPalAccessToken();
    
    // 1. Check for duplicate capture request (Idempotency)
    const [existing] = await db.query('SELECT id, order_number, total, currency FROM orders WHERE payment_reference = ?', [paypalOrderId]);
    if (existing.length > 0) {
      logger.info(`Idempotent capture: Order already exists for ${paypalOrderId}`);
      return res.json({
        success: true,
        order: {
          id: existing[0].id,
          orderNumber: existing[0].order_number,
          total: existing[0].total,
          currency: existing[0].currency
        }
      });
    }

    // 2. Pre-create Order in 'pending' status (This deducts stock)
    // This ensures we have a record if capture succeeds but our server crashes/times out
    let order;
    try {
      order = await Order.createOrder({
        customerId: req.user?.id || null,
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
        notes: `PayPal Order ID: ${paypalOrderId}`
      });
    } catch (dbErr) {
      logger.error(`Failed to pre-create order: ${dbErr.message}`);
      return res.status(500).json({ success: false, message: 'Failed to initiate order. Please try again.' });
    }

    // 3. Capture the payment
    try {
      const captureResponse = await axios({
        url: `${PAYPAL_API}/v2/checkout/orders/${paypalOrderId}/capture`,
        method: 'post',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        }
      });

      if (captureResponse.data.status !== 'COMPLETED') {
        throw new Error(`PayPal payment status: ${captureResponse.data.status}`);
      }

      const captureMeta = captureResponse.data.purchase_units[0].payments.captures[0];
      const captureId = captureMeta.id;
      const captureAmount = parseFloat(captureMeta.amount.value);

      // 4. Verify amount matches
      const expectedTotal = parseFloat(total);
      if (Math.abs(captureAmount - expectedTotal) > 0.01) {
        logger.error(`CRITICAL: Amount mismatch! PayPal: ${captureAmount}, Expected: ${expectedTotal}. Refund required.`);
        // We've already captured the money, we must keep the order but mark it for review
        await Order.updateOrder(order.id, { 
          payment_status: 'flagged_mismatch', 
          payment_reference: captureId,
          notes: `CRITICAL: Amount mismatch! PayPal: ${captureAmount}, Expected: ${expectedTotal}`
        });
        throw new Error('Payment amount mismatch detected.');
      }

      // 5. Success: Finalize Order
      await Order.updatePaymentStatus(order.id, {
        paymentStatus: 'paid',
        paymentReference: captureId,
        paymentMethod: 'paypal'
      });

      // 6. Trigger Fulfillment
      fulfillOrder(order.id).catch(err => {
        logger.error(`Background fulfillment failed for order ${order.id}: ${err.message}`);
      });

      res.json({
        success: true,
        order: {
          id: order.id,
          orderNumber: order.order_number,
          total: order.total,
          currency: order.currency
        }
      });

    } catch (captureErr) {
      logger.error(`PayPal Capture Failed for Order ${order.id}: ${captureErr.message}`);
      
      // 7. Critical: Restore stock and mark order as cancelled
      try {
        await Product.restoreStock(validation.items);
        await Order.updateOrder(order.id, { 
          status: 'cancelled', 
          payment_status: 'failed',
          notes: `Capture Failed: ${captureErr.message}`
        });
      } catch (cleanupErr) {
        logger.error(`FAILED TO CLEANUP FAILED ORDER ${order.id}: ${cleanupErr.message}`);
      }

      const msg = captureErr.response?.data?.message || captureErr.message;
      res.status(500).json({ success: false, message: `Payment capture failed: ${msg}` });
    }

  } catch (err) {
    logger.error(`General Capture Workflow Error: ${err.message}`, { stack: err.stack });
    res.status(500).json({ success: false, message: 'An unexpected error occurred during payment processing.' });
  }
});

export default router;
