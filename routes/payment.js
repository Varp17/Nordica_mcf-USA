import express from 'express';
import axios from 'axios';
import db from '../config/database.js';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import { fulfillOrder } from '../services/fulfillmentService.js';
import logger from '../utils/logger.js';
import { authenticateToken } from '../middleware/auth.js';

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
    
    const paypalOrder = {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: currency || (country === 'CA' ? 'CAD' : 'USD'),
          value: total.toFixed(2),
          breakdown: {
            item_total: { currency_code: currency, value: subtotal.toFixed(2) },
            shipping: { currency_code: currency, value: shippingCost.toFixed(2) },
            tax_total: { currency_code: currency, value: tax.toFixed(2) }
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
router.post('/capture', authenticateToken, async (req, res) => {
  try {
    const { paypalOrderId, country, email, items, shipping, shippingSpeed, subtotal, tax, shippingCost, total, currency } = req.body;
    
    // 0. Validate items and prices server-side to prevent tampering
    const validation = await Product.validateCartItems(items, country);
    if (!validation.valid) {
      throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
    }

    const accessToken = await getPayPalAccessToken();
    
    // 1. Capture the payment
    const captureResponse = await axios({
      url: `${PAYPAL_API}/v2/checkout/orders/${paypalOrderId}/capture`,
      method: 'post',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      }
    });

    if (captureResponse.data.status !== 'COMPLETED') {
      throw new Error(`PayPal payment not completed: ${captureResponse.data.status}`);
    }

    const captureId = captureResponse.data.purchase_units[0].payments.captures[0].id;

    // 2. Create Order in our DB
    // We use the same logic as orderRoutes.js but integrated here for the capture flow
    const order = await Order.createOrder({
      customerId: req.user?.id || null, // Optional if guest
      country,
      items,
      shipping,
      shippingSpeed: shippingSpeed || 'standard',
      paymentMethod: 'paypal',
      paymentReference: captureId,
      paymentStatus: 'paid',
      subtotal: parseFloat(subtotal),
      tax: parseFloat(tax || 0),
      shippingCost: parseFloat(shippingCost || 0),
      total: parseFloat(total),
      currency: currency || (country === 'CA' ? 'CAD' : 'USD'),
      customer_email: email
    });

    // 3. Trigger Fulfillment
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

  } catch (err) {
    logger.error(`PayPal Capture Error: ${err.message}`, { response: err.response?.data });
    res.status(500).json({ success: false, message: 'Failed to capture payment or create order' });
  }
});

export default router;
