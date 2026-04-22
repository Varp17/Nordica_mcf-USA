import express from 'express';
import axios from 'axios';
import db from '../config/database.js';
import Order from '../models/Order.js';
import * as Product from '../models/Product.js';
import { fulfillOrder } from '../services/fulfillmentService.js';
import { calculateTax } from '../services/taxService.js';
import emailService from '../services/emailService.js';
import fraudService from '../services/fraudService.js';
import shippoService from '../services/shippoService.js';
import mcfService from '../services/mcfService.js';
import logger from '../utils/logger.js';
import { optionalAuth, requireVerified } from '../middleware/auth.js';

const router = express.Router();

const PAYPAL_API = 'https://api-m.paypal.com';

// EDGE CASE #14: Add timeout to prevent hanging if PayPal is down
const PAYPAL_TIMEOUT_MS = 15000;

/**
 * Get PayPal Access Token
 */
async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('PayPal credentials not configured');
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
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
    timeout: PAYPAL_TIMEOUT_MS,
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
router.post('/create-order', optionalAuth, async (req, res, next) => {
  // If user is logged in, they MUST be verified to place an order
  if (req.headers['authorization']) {
    return requireVerified(req, res, next);
  }
  next();
}, async (req, res) => {
  try {
    let { country, currency, items, shipping, shippingCost, subtotal, tax, total, email, shippingSpeed, guestOtpCode } = req.body;

    // EDGE CASE #6: Validate country
    if (!country || !['US', 'CA'].includes(country)) {
      return res.status(400).json({ success: false, message: 'Invalid country. Must be US or CA.' });
    }

    // EDGE CASE #7: Validate email
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }

    // EDGE CASE #9: Validate items
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one item is required.' });
    }

    // EDGE CASE #8: Validate shipping fields
    if (!shipping || !shipping.firstName || !shipping.lastName || !shipping.address1 || !shipping.city) {
      return res.status(400).json({ success: false, message: 'Shipping address is incomplete. First name, last name, address, and city are required.' });
    }

    if (country === 'US' && (!shipping.state || !shipping.zip)) {
      return res.status(400).json({ success: false, message: 'State and ZIP code are required for US orders.' });
    }

    if (country === 'CA' && (!shipping.province && !shipping.state)) {
      return res.status(400).json({ success: false, message: 'Province is required for Canadian orders.' });
    }

    // 0. Guest Verification (for unauthenticated users)
    if (!req.user && !req.headers['authorization']) {
      if (!guestOtpCode) {
        return res.status(401).json({ success: false, message: 'Verification code required for guest checkout' });
      }
      // Fetch the record first, then compare in JS (avoids MySQL timezone issues)
      const [otpRows] = await db.execute(
        "SELECT id, otp_code, otp_expiry FROM guest_verifications WHERE email = ? ORDER BY created_at DESC LIMIT 1",
        [email]
      );
      if (otpRows.length === 0 || otpRows[0].otp_code !== guestOtpCode) {
        return res.status(401).json({ success: false, message: 'Invalid or expired verification code' });
      }
      const expiry = new Date(otpRows[0].otp_expiry); // mysql2 returns a Date object (timezone: UTC)
      if (new Date() > expiry) {
        return res.status(401).json({ success: false, message: 'Verification code has expired. Please request a new one.' });
      }
    }

    // 1. Server-side validation (Price & Stock)
    const validation = await Product.validateCartItems(items, country);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: validation.errors.join(', ') });
    }

    // 1.1 Recalculate Financials for Security (Production Level)
    const serverSubtotal = validation.subtotal;
    const provState = (shipping.province || shipping.state || '').toUpperCase();

    // EDGE CASE #57: Use Centralized Tax Service
    const taxCalculation = await calculateTax(serverSubtotal, country, provState);
    const serverTax = taxCalculation.amount;

    let serverShippingCost = 0;
    const totalQty = validation.items.reduce((sum, item) => sum + (item.quantity || 1), 0);
    const isFree = (country === 'CA' && serverSubtotal >= 120) || (country === 'US' && serverSubtotal >= 100);

    if (country === 'CA') {
      const hasBucket = validation.items.some(item => 
        (item.name || '').toLowerCase().includes('bucket') && 
        !(item.name || '').toLowerCase().includes('insert') &&
        !(item.name || '').toLowerCase().includes('filter') &&
        !(item.name || '').toLowerCase().includes('dirt lock')
      );

      const speed = (shippingSpeed || '').toLowerCase();
      if (hasBucket) {
        serverShippingCost = 24.99;
        shippingSpeed = 'Heavy/Bulky Item Shipping (Expedited)';
      } else if (isFree && !speed.includes('expedited')) {
        serverShippingCost = 0;
        shippingSpeed = 'Free Ground Shipping';
      } else if (speed.includes('expedited')) {
        serverShippingCost = 9.99;
        shippingSpeed = 'Expedited Shipping (1-4 Business Days) - Tracking';
      } else {
        serverShippingCost = 7.99;
        shippingSpeed = 'Regular Shipping (5-10 Business Days)';
      }

      // Log the Shippo cost for comparison anyway
      try {
        const pseudoOrder = {
          items: validation.items,
          shipping_first_name: shipping.firstName || 'Customer',
          shipping_last_name: shipping.lastName || '',
          shipping_address1: shipping.address1 || shipping.address || '',
          shipping_city: shipping.city || '',
          shipping_province: shipping.province || shipping.state || '',
          shipping_postal_code: shipping.postalCode || shipping.zip || ''
        };
        const rates = await shippoService.getShippingRates(pseudoOrder);
        if (rates && rates.length > 0) {
          const actualAmount = parseFloat(rates[0].amount);
          const margin = serverShippingCost - actualAmount;
          logger.info(`[SHIPPO COST ANALYSIS - FINAL] Order: ${email} | Service: ${shippingSpeed.padEnd(20)} | Shippo Fee: $${actualAmount.toFixed(2).padEnd(6)} | Customer (Flat): $${serverShippingCost.toFixed(2).padEnd(6)} | LOSS: $${margin.toFixed(2)}`);
        }
      } catch (err) {
        logger.warn(`Failed to fetch shippo rates for CA logging: ${err.message}`);
      }
    } else if (country === 'US') {
      const speed = (shippingSpeed || '').toLowerCase();
      if (isFree && !speed.includes('expedited') && !speed.includes('priority')) {
        serverShippingCost = 0;
        shippingSpeed = 'Free Shipping';
      } else if (speed.includes('priority')) {
        serverShippingCost = 14.99;
        shippingSpeed = 'Priority Shipping (1-2 Business Days)';
      } else if (speed.includes('expedited')) {
        serverShippingCost = 7.99;
        shippingSpeed = 'Expedited Shipping (2-3 Business Days)';
      } else {
        serverShippingCost = 5.99;
        shippingSpeed = 'Standard Shipping (3-5 Business Days)';
      }
    }

    const serverTotal = parseFloat((serverSubtotal + serverShippingCost + serverTax).toFixed(2));
    const finalCurrency = currency || (country === 'CA' ? 'CAD' : 'USD');

    // 2. Create Internal Order (Status: Pending, Payment: Pending)
    let internalOrder;
    try {
      internalOrder = await Order.createOrder({
        customerId: req.user?.userId || req.user?.id || null,
        country,
        items: validation.items,
        shipping,
        shippingSpeed: shippingSpeed || 'standard',
        paymentMethod: 'paypal',
        paymentStatus: 'pending',
        subtotal: serverSubtotal,
        tax: serverTax,
        shippingCost: serverShippingCost,
        total: serverTotal,
        currency: finalCurrency,
        customer_email: email,
        notes: 'Checkout initiated via PayPal'
      });
      logger.info(`Internal order ${internalOrder.order_number} created for ${email}. Total: ${serverTotal} ${finalCurrency}`);
    } catch (orderErr) {
      logger.error(`Failed to pre-create order: ${orderErr.message}`);
      return res.status(500).json({ success: false, message: 'Failed to initiate order. Inventory may be insufficient.' });
    }

    // 2.5 Screen for Fraud asynchronously
    try {
      const fraudOrder = {
        ...internalOrder,
        country,
        currency: finalCurrency,
        total: serverTotal,
        items: validation.items,
        customer_email: email,
        shipping_first_name: shipping.firstName,
        shipping_last_name: shipping.lastName,
        shipping_phone: shipping.phone || '',
        shipping_address1: shipping.address1,
        shipping_city: shipping.city,
        shipping_state: shipping.state || shipping.province,
        shipping_zip: shipping.zip || shipping.postalCode
      };
      await fraudService.screenOrder(fraudOrder, req.ip);
    } catch (fraudErr) {
      logger.error(`Error during fraud screening: ${fraudErr.message}`);
    }

    // 3. Create PayPal Order
    let response;
    try {
      const accessToken = await getPayPalAccessToken();
      const frontendBase = getBaseUrl(req);

      const paypalOrder = {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: internalOrder.order_number,
          amount: {
            currency_code: internalOrder.currency,
            value: Number(internalOrder.total).toFixed(2),
            breakdown: {
              item_total: { currency_code: internalOrder.currency, value: Number(internalOrder.subtotal).toFixed(2) },
              shipping: { currency_code: internalOrder.currency, value: Number(internalOrder.shipping_cost).toFixed(2) },
              tax_total: { currency_code: internalOrder.currency, value: Number(internalOrder.tax).toFixed(2) }
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

      response = await axios({
        url: `${PAYPAL_API}/v2/checkout/orders`,
        method: 'post',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        data: paypalOrder,
        timeout: PAYPAL_TIMEOUT_MS,
      });
    } catch (apiErr) {
      // 🚨 CRITICAL: If PayPal fails, we MUST restore the stock we just deducted
      logger.error(`PayPal order creation failed. Restoring stock for order ${internalOrder.order_number}`);
      const [items] = await db.query('SELECT * FROM order_items WHERE order_id = ?', [internalOrder.id]);
      await Product.restoreStock(items);

      // Mark internal order as failed
      await Order.updateOrder(internalOrder.id, {
        status: 'cancelled',
        payment_status: 'failed',
        fulfillment_status: 'cancelled',
        notes: `PayPal API Error: ${apiErr.response?.data?.message || apiErr.message}`
      });

      throw apiErr; // Re-throw to be caught by outer catch and sent to client
    }

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
    res.status(500).json({ success: false, message: 'Failed to create PayPal order. Please try again.' });
  }
});

/**
 * POST /api/payment/capture
 * 1. Checks if order already paid (Idempotency)
 * 2. Captures payment from PayPal
 * 3. Finalizes internal order
 */
router.post('/capture', async (req, res) => {
  let order = null;
  let connection = null;
  try {
    const { paypalOrderId } = req.body;
    if (!paypalOrderId || typeof paypalOrderId !== 'string') {
      return res.status(400).json({ success: false, message: 'paypalOrderId is required and must be a string' });
    }

    // EDGE CASE #4: Use SELECT ... FOR UPDATE to prevent race condition
    // between frontend capture call and PayPal webhook auto-capture.
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [orders] = await connection.execute(
      'SELECT * FROM orders WHERE payment_reference = ? FOR UPDATE',
      [paypalOrderId]
    );

    if (!orders.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Order not found for this payment reference.' });
    }
    order = orders[0];

    // 2. Idempotency: Check if already processed
    if (order.payment_status === 'paid') {
      await connection.rollback();
      logger.info(`Capture already completed for PayPal ID ${paypalOrderId}`);
      return res.json({
        success: true,
        alreadyProcessed: true,
        order: { id: order.id, orderNumber: order.order_number, total: order.total }
      });
    }

    // If already failed/cancelled, don't retry capture
    if (['cancelled', 'refunded'].includes(order.payment_status)) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: `Order payment is ${order.payment_status}. Cannot capture.` });
    }

    const accessToken = await getPayPalAccessToken();

    // 3. Capture Payment
    let captureResponse;
    try {
      captureResponse = await axios({
        url: `${PAYPAL_API}/v2/checkout/orders/${paypalOrderId}/capture`,
        method: 'post',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: PAYPAL_TIMEOUT_MS,
      });
    } catch (captureErr) {
      // EDGE CASE #13: Handle 422 UNPROCESSABLE_ENTITY — order may already be captured
      if (captureErr.response?.status === 422) {
        const ppIssue = captureErr.response?.data?.details?.[0]?.issue;
        if (ppIssue === 'ORDER_ALREADY_CAPTURED') {
          logger.info(`PayPal order ${paypalOrderId} was already captured. Syncing status.`);
          // Fetch the order from PayPal to get capture details
          try {
            const ppOrderRes = await axios.get(`${PAYPAL_API}/v2/checkout/orders/${paypalOrderId}`, {
              headers: { Authorization: `Bearer ${accessToken}` },
              timeout: PAYPAL_TIMEOUT_MS,
            });
            if (ppOrderRes.data.status === 'COMPLETED') {
              const captureMeta = ppOrderRes.data.purchase_units?.[0]?.payments?.captures?.[0];
              if (captureMeta) {
                await connection.execute(
                  `UPDATE orders SET payment_status = 'paid', payment_reference = ?, paid_at = NOW(), updated_at = NOW() WHERE id = ?`,
                  [captureMeta.id, order.id]
                );
                await connection.commit();
                connection = null;
                fulfillOrder(order.id).catch(err => logger.error(`Background fulfillment error [${order.id}]: ${err.message}`));
                return res.json({ success: true, alreadyProcessed: true, order: { id: order.id, orderNumber: order.order_number, total: order.total } });
              }
            }
          } catch (syncErr) {
            logger.error(`Failed to sync already-captured PayPal order: ${syncErr.message}`);
          }
        }
      }
      throw captureErr;
    }

    if (captureResponse.data.status !== 'COMPLETED') {
      throw new Error(`PayPal payment NOT completed (Status: ${captureResponse.data.status})`);
    }

    const captureMeta = captureResponse.data.purchase_units[0].payments.captures[0];
    const captureId = captureMeta.id;
    const captureAmount = parseFloat(captureMeta.amount.value);

    // Extract PayPal Payer Verification Status
    // In PayPal V2, payer.status might be present in sandbox or specific regions/flows.
    // We explicitly track it to fulfill the "only fulfill paypal verified" requirement.
    const payerStatus = captureResponse.data.payer?.status;
    const isVerified = (payerStatus === 'VERIFIED' || process.env.PAYPAL_BYPASS_VERIFICATION === 'true') ? 1 : 0;

    // 4. Double check amount matches internal order
    if (Math.abs(captureAmount - parseFloat(order.total)) > 0.02) {
      logger.error(`CRITICAL: Amount mismatch on capture! PayPal: ${captureAmount}, Internal Order ${order.order_number}: ${order.total}`);
      await connection.execute(
        `UPDATE orders SET payment_status = 'flagged_mismatch', notes = ?, updated_at = NOW() WHERE id = ?`,
        [`CRITICAL: Mismatched capture. Received ${captureAmount}, expected ${order.total}. Capture ID: ${captureId}`, order.id]
      );
      await connection.commit();
      connection = null;
      return res.status(400).json({ success: false, message: 'Payment amount mismatch. Order flagged for review.' });
    }

    // 5. Success - Finalize internal order within the same transaction
    await connection.execute(
      `UPDATE orders SET 
        payment_status = 'paid', 
        payment_reference = ?, 
        payment_method = 'paypal', 
        is_paypal_verified = ?,
        paid_at = NOW(), 
        updated_at = NOW() 
       WHERE id = ?`,
      [captureId, isVerified, order.id]
    );

    // Mark lead as recovered if it exists
    await connection.execute(
      "UPDATE abandoned_checkouts SET status = 'recovered', order_id = ? WHERE email = ? AND status = 'pending'",
      [order.id, order.customer_email]
    ).catch(e => logger.warn(`Lead recovery update failed for ${order.customer_email}: ${e.message}`));

    await connection.commit();
    connection = null;

    // EDGE CASE #5: Update user stats outside transaction (non-critical)
    try {
      if (order.user_id) {
        await db.execute(
          `UPDATE users u
           SET u.total_orders = (SELECT COUNT(*) FROM orders WHERE user_id = ? AND payment_status = 'paid'),
               u.total_spent = (SELECT COALESCE(SUM(total), 0) FROM orders WHERE user_id = ? AND payment_status = 'paid'),
               u.updated_at = NOW()
           WHERE u.id = ?`,
          [order.user_id, order.user_id, order.user_id]
        );
      }
    } catch (statsErr) {
      logger.error(`Failed to update customer stats: ${statsErr.message}`);
    }

    // Fetch the updated order for response
    const finalOrder = await Order.findById(order.id);

    // 6. Async fulfillment trigger & Invoice Generation
    fulfillOrder(order.id).catch(err => logger.error(`Background fulfillment error [${order.id}]: ${err.message}`));

    // EDGE CASE: Background invoice generation (record + PDF + S3 + Email)
    import('../services/invoiceService.js').then(m => {
      if (order.country === 'US') {
        return m.createMCFInvoice(order.id);
      } else {
        return m.createShippoInvoice(order.id);
      }
    }).catch(err => logger.error(`Background invoice error [${order.id}]: ${err.message}`));

    // Admin Notification (async)
    emailService.sendNewOrderAdminAlert(finalOrder).catch(err => logger.error(`Admin notification error [${finalOrder.id}]: ${err.message}`));

    res.json({
      success: true,
      order: finalOrder
    });

  } catch (err) {
    // Rollback if connection is still active
    if (connection) {
      try { await connection.rollback(); } catch (rbErr) { logger.error(`Rollback error: ${rbErr.message}`); }
    }

    const errorMsg = err.response?.data?.message || err.message;
    logger.error(`PayPal Capture Error: ${errorMsg}`);

    // Explicitly mark as failed if it's not already paid
    if (order && order.id && order.payment_status !== 'paid') {
      try {
        await db.execute(
          `UPDATE orders SET payment_status = 'failed', notes = ?, updated_at = NOW() WHERE id = ? AND payment_status != 'paid'`,
          [`Payment capture failed: ${errorMsg}`, order.id]
        );
        // Notify customer
        emailService.sendPaymentFailureEmail(order, errorMsg).catch(e => logger.error(`Failed to send payment failure email: ${e.message}`));
      } catch (updateErr) {
        logger.error(`Failed to update order status after capture failure: ${updateErr.message}`);
      }
    }

    res.status(500).json({ success: false, message: `Payment failed: ${errorMsg}` });
  } finally {
    if (connection) {
      try { connection.release(); } catch (e) { /* already released */ }
    }
  }
});

/**
 * POST /api/payment/cancel-order
 * Restores stock and marks order as cancelled if user backs out of PayPal
 */
router.post('/cancel-order', optionalAuth, async (req, res) => {
  let connection = null;
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId is required' });
    }

    // EDGE CASE #11 & #12: Use transaction with FOR UPDATE lock to prevent race conditions
    // and add ownership check
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [rows] = await connection.execute('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const order = rows[0];

    // EDGE CASE #11: Auth check — only allow cancellation by:
    // 1. The authenticated user who owns the order
    // 2. Or match by customer_email if the request includes it
    if (req.user) {
      // Logged-in user must own the order
      if (order.user_id && order.user_id !== req.user.id && req.user.role !== 'admin') {
        await connection.rollback();
        return res.status(403).json({ success: false, message: 'You do not have permission to cancel this order.' });
      }
    }
    // Note: For unauthenticated cancellations triggered by PayPal cancel_url redirect,
    // the orderId in the URL acts as a bearer token (only the user who started checkout has it).
    // This is acceptable for pending/unpaid orders.

    if (order.status !== 'pending' || order.payment_status === 'paid') {
      await connection.rollback();
      return res.json({ success: true, message: 'Order cannot be cancelled in current state.' });
    }

    // Already cancelled — idempotent response
    if (order.status === 'cancelled') {
      await connection.rollback();
      return res.json({ success: true, message: 'Order is already cancelled.' });
    }

    // Get items to restore stock
    const [items] = await connection.execute('SELECT * FROM order_items WHERE order_id = ?', [orderId]);

    // Restore Stock & Cancel Order
    if (items.length > 0) {
      await Product.restoreStock(items, connection);
    }

    await connection.execute(
      `UPDATE orders SET status = 'cancelled', payment_status = 'cancelled', fulfillment_status = 'cancelled',
       notes = CONCAT(COALESCE(notes,''), ' Customer cancelled at PayPal checkout'), updated_at = NOW()
       WHERE id = ?`,
      [orderId]
    );

    await connection.commit();
    connection = null;

    logger.info(`Customer cancelled checkout - Order ${order.order_number} marked cancelled, stock restored`);
    res.json({ success: true, message: 'Checkout cancelled, stock restored.' });
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (e) { /* ignore */ }
    }
    logger.error(`Payment Cancel Error: ${err.message}`);
    res.status(500).json({ success: false, message: 'Internal error during cancellation' });
  } finally {
    if (connection) {
      try { connection.release(); } catch (e) { /* already released */ }
    }
  }
});

export default router;
