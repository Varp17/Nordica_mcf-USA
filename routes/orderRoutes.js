import express from 'express';
import db from '../config/database.js';
import Order from '../models/Order.js';
import Customer from '../models/Customer.js';
import * as Product from '../models/Product.js';
import { fulfillOrder, retryFailedOrder } from '../services/fulfillmentService.js';
import mcfService from '../services/mcfService.js';
import shippoService from '../services/shippoService.js';
import { calculateTax } from '../services/taxService.js';
import emailService from '../services/emailService.js';
import { authenticateToken as requireAuth, requireAdmin, requireVerified, optionalAuth } from '../middleware/auth.js';
import { validateCreateOrder, validateOrderId } from '../middleware/validation.js';
// COMMENTED: detectCountryFromRequest not used in this file (country comes from req.body)
// import { detectCountryFromRequest } from '../utils/helpers.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Compatibility: requireRole('admin') -> requireAdmin
const requireRole = (role) => (role === 'admin' ? requireAdmin : (req, res, next) => next());
// COMMENTED: optionalAuthStub is deprecated — real optionalAuth from middleware is used
// const optionalAuthStub = (req, res, next) => next();

/**
 * Order Routes
 * ─────────────
 * POST   /api/orders                 — Create a new order (after payment)
 * GET    /api/orders/:orderId        — Get order details (customer-facing)
 * GET    /api/orders/number/:number  — Get by order number
 * GET    /api/orders/my              — Get authenticated customer's orders
 * POST   /api/orders/:orderId/retry  — Retry failed fulfillment (admin)
 */

// REMOVED: Legacy CommonJS require() comments (migrated to ESM imports above)

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/orders
//  Create a new order + trigger fulfillment.
//
//  Expects body:
//  {
//    country: 'US' | 'CA',
//    email: 'customer@email.com',
//    items: [{ sku, quantity }],
//    shipping: { firstName, lastName, address1, address2, city, state/province, zip/postalCode, phone },
//    shippingSpeed: 'standard' | 'expedited' | 'priority',
//    paymentMethod: 'stripe' | 'paypal',
//    paymentReference: 'stripe_charge_id or paypal_txn_id',
//    subtotal, tax, shippingCost, total, currency
//  }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', optionalAuth, validateCreateOrder, async (req, res) => {
  try {
    const {
      country, email, items, shipping, shippingSpeed,
      paymentMethod, paymentReference,
      subtotal, tax, shippingCost, total, currency,
      notes, guestOtpCode
    } = req.body;

    // ── 0. Security: Guest vs Auth Check ────────────────────────────────────
    let customerId = null;
    if (!req.user) {
      // If no valid user session, we require guest verification (OTP)
      if (!guestOtpCode) {
        return res.status(401).json({ success: false, message: 'Verification code required for guest checkout' });
      }

      const [otpRows] = await db.execute(
        "SELECT id FROM guest_verifications WHERE email = ? AND otp_code = ? AND otp_expiry > NOW() ORDER BY created_at DESC LIMIT 1",
        [email, guestOtpCode]
      );

      if (otpRows.length === 0) {
        return res.status(401).json({ success: false, message: 'Invalid or expired verification code' });
      }

      // Cleanup OTP
      await db.execute("DELETE FROM guest_verifications WHERE email = ?", [email]);
      logger.info(`Guest verified for order: ${email}`);
    } else {
      customerId = req.user.id;
      // Ensure verified
      const [vRows] = await db.execute("SELECT is_email_verified FROM users WHERE id = ?", [customerId]);
      if (!vRows[0]?.is_email_verified) {
        return res.status(403).json({ success: false, message: 'Account must be verified to place orders' });
      }
    }


    // ── 1. Validate & price cart items ────────────────────────────────────────
    const validation = await Product.validateCartItems(items, country);
    const { valid, errors, items: validatedItems } = validation;

    if (!valid) {
      logger.error('Order creation: Cart validation failed', { errors, items });
      return res.status(400).json({ success: false, message: 'Cart validation failed', errors });
    }

    // ── 2. Handle Regional Logic Separately ───────────────────────────────────
    const serverSubtotal = validation.subtotal;
    const ship = shipping || {};
    const provState = (ship.province || ship.state || '').toUpperCase();
    
    const taxRes = await calculateTax(serverSubtotal, country, provState);
    const serverTax = taxRes.amount;

    let serverShippingCost = 0;
    const totalQty = validatedItems.reduce((sum, item) => sum + (item.quantity || 1), 0);
    const freeThreshold = country === 'CA' ? 120 : 100;
    const isFree = serverSubtotal >= freeThreshold;

    if (isFree) {
      serverShippingCost = 0;
    } else if (country === 'CA') {
      serverShippingCost = parseFloat((totalQty * 10).toFixed(2));
    } else {
      // USA SPECIFIC LOGIC: Fixed Flat Rates $5 / $7 / $15
      const speed = (shippingSpeed || '').toLowerCase();
      if (speed.includes('priority')) {
        serverShippingCost = 15.00;
      } else if (speed.includes('expedited')) {
        serverShippingCost = 7.00;
      } else {
        serverShippingCost = 5.00;
      }
    }

    const serverTotal = parseFloat((serverSubtotal + serverShippingCost + serverTax).toFixed(2));

    // ── 3. Find or create customer entry ──────────────────────────────────────
    const customer = await Customer.findOrCreate({
      email,
      firstName: ship.firstName,
      lastName: ship.lastName,
      phone: ship.phone,
      country
    });

    if (!customerId) {
        customerId = customer.id;
    }

    // ── 4. Create order in DB ─────────────────────────────────────────────────
    const order = await Order.createOrder({
      customerId: customerId,
      country,
      items: validatedItems,
      shipping,
      shippingSpeed: shippingSpeed || 'standard',
      paymentMethod,
      paymentReference,
      paymentStatus: 'paid',
      subtotal: serverSubtotal,
      tax: serverTax,
      shippingCost: serverShippingCost,
      total: serverTotal,
      currency: currency || (country === 'CA' ? 'CAD' : 'USD'),
      customer_email: email,
      notes
    });

    // ── 5. Post-Creation Regional Logic ──────────────────────────────────────
    if (country === 'US') {
      // Record MCF Actual Margin for US Analytics
      try {
        const address = {
          name: `${shipping?.firstName || ''} ${shipping?.lastName || ''}`.trim() || 'Valued Customer',
          line1: shipping?.address1 || shipping?.address,
          city: shipping?.city,
          stateOrRegion: shipping?.state,
          postalCode: shipping?.zip,
          countryCode: 'US'
        };

        const previews = await mcfService.getFulfillmentPreview(address, validatedItems);
        let targetSpeed = shippingSpeed || 'Standard';
        if (targetSpeed.includes('_DYNAMIC')) targetSpeed = targetSpeed.replace('_DYNAMIC', '');
        const normalizedTarget = targetSpeed.charAt(0).toUpperCase() + targetSpeed.slice(1).toLowerCase();

        const exactPreview = previews.find(p => p.shippingSpeedCategory === normalizedTarget);
        if (exactPreview) {
            const actualCost = parseFloat(exactPreview.totalFee || 0);
            const lossMargin = parseFloat((serverShippingCost - actualCost).toFixed(2));
            await Order.updateOrder(order.id, { actual_shipping_cost: actualCost, shipping_profit_loss: lossMargin });
        }
      } catch (e) {
        logger.error(`Failed to calculate MCF shipping loss for ${order.id}: ${e.message}`);
      }
    }

    // ── 6. Trigger fulfillment (async) & Invoice Generation ──────────────────
    fulfillOrder(order.id).catch((err) => {
      logger.error(`Background fulfillment failed for order ${order.id}: ${err.message}`);
    });

    import('../services/invoiceService.js').then(m => m.createInvoiceFromOrder(order.id))
      .catch(err => logger.error(`Background invoice error [${order.id}]: ${err.message}`));

    // ── 7. Admin Notification (async) ────────────────────────────────────────
    emailService.sendNewOrderAdminAlert(order).catch(err => logger.error(`Admin notification error [${order.id}]: ${err.message}`));

    logger.info(`Order created: ${order.order_number} | Country: ${country} | Total: ${serverTotal}`);

    return res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      order: {
        id: order.id,
        orderNumber: order.order_number,
        status: order.fulfillment_status,
        total: order.total,
        subtotal: order.subtotal,
        tax: order.tax,
        shippingCost: order.shipping_cost,
        currency: order.currency,
        country: order.country
      }
    });

  } catch (err) {
    logger.error(`POST /api/orders error: ${err.message}`, { stack: err.stack });
    return res.status(500).json({ success: false, message: 'Failed to create order', error: err.message });
  }
});

/**
 * POST /api/orders/shipping-rates
 * Get live shipping rates and delivery estimates.
 */
router.post('/shipping-rates', async (req, res) => {
  try {
    const { country, shipping, items } = req.body;

    if (!country || !items || !items.length) {
      return res.status(400).json({ success: false, message: 'Country and items are required' });
    }

    // 1. Validate items
    const { valid, errors, items: validatedItems } = await Product.validateCartItems(items, country);
    if (!valid) {
      return res.status(400).json({ success: false, message: 'Cart validation failed', errors });
    }

    let rates = [];

    const subtotal = validatedItems.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
    const freeThreshold = country === 'CA' ? 120 : 100;
    const isFree = subtotal >= freeThreshold;

    // 2. Fetch rates based on country
    if (country === 'US') {
      const allOptions = [
        { id: 'standard', name: 'Standard Shipping (3-5 Business Days)', price: isFree ? 0 : 5.00, currency: 'USD', estimation: 'Estimated 3-5 business days', speed: 'Standard' },
        { id: 'expedited', name: 'Expedited Shipping (2-3 Business Days)', price: isFree ? 0 : 7.00, currency: 'USD', estimation: 'Estimated 2-3 business days', speed: 'Expedited' },
        { id: 'priority', name: 'Priority Shipping (1-2 Business Days)', price: isFree ? 0 : 15.00, currency: 'USD', estimation: 'Estimated 1-2 business days', speed: 'Priority' }
      ];

      try {
        const address = {
          name: `${shipping?.firstName || ''} ${shipping?.lastName || ''}`.trim() || 'Valued Customer',
          line1: shipping?.address1 || '123 Main St',
          city: shipping?.city || 'New York',
          stateOrRegion: shipping?.state || shipping?.province || 'NY',
          postalCode: shipping?.zip || shipping?.postalCode || '10001',
          countryCode: 'US'
        };
        const previews = await mcfService.getFulfillmentPreview(address, validatedItems);
        const availableSpeeds = new Set(previews.filter(p => p.isFulfillable).map(p => p.shippingSpeedCategory));
        
        rates = allOptions
          .filter(o => availableSpeeds.has(o.speed))
          .map(({ speed, ...rest }) => ({ ...rest, isFulfillable: true }));

      } catch (e) {
        logger.error(`MCF Availability Check Failed: ${e.message}`);
      }

      if (rates.length === 0) {
        rates = [allOptions[0]].map(({ speed, ...rest }) => ({ ...rest, isFulfillable: true }));
      }
    } else if (country === 'CA') {
      const totalQty = validatedItems.reduce((sum, item) => sum + (item.quantity || 1), 0);
      rates = [{
        id: 'standard_ca',
        name: 'Regular Shipping (5-10 Business Days)',
        price: isFree ? 0 : parseFloat((totalQty * 10).toFixed(2)),
        currency: 'CAD',
        estimation: 'Estimated 3-7 business days',
        isFulfillable: true
      }];
    }

    return res.json({ success: true, rates });
  } catch (err) {
    logger.error(`POST /api/orders/shipping-rates error: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Failed to fetch shipping rates' });
  }
});

// EDGE CASE #16: Move /my BEFORE /:orderId to prevent route shadowing
// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/orders/my
//  Customer's order history.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/my', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ success: false, message: 'Only customers can access their order history' });
    }

    const { orders } = await Order.findByCustomer(req.user.id, { limit: 100 });
    const sanitized = orders.map(o => _sanitizeOrder(o, false));

    return res.json({ success: true, orders: sanitized });
  } catch (err) {
    logger.error(`GET /api/orders/my error: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Failed to fetch order history' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/orders/number/:orderNumber
//  Lookup by human-readable order number.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/number/:orderNumber', optionalAuth, async (req, res) => {
  try {
    const order = await Order.findByOrderNumber(req.params.orderNumber);

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // EDGE CASE #20: Authorization check for lookup by order number
    let isFullDetail = false;
    if (!req.user || req.user.role !== 'admin') {
      const { email } = req.query;
      if (!email || email.toLowerCase() !== order.customer_email?.toLowerCase()) {
        if (req.user && req.user.role === 'customer' && req.user.id === order.user_id) {
          isFullDetail = true;
        } else {
          return res.status(403).json({ success: false, message: 'Access denied. Please provide order email or login.' });
        }
      } else {
        isFullDetail = true;
      }
    } else {
      isFullDetail = true;
    }

    return res.json({ success: true, order: _sanitizeOrder(order, isFullDetail) });

  } catch (err) {
    logger.error(`GET /api/orders/number/:orderNumber error: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Failed to fetch order' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/orders/:orderId
//  Public order lookup (customer checks their own order).
//  Uses email as an ownership check if not authenticated.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:orderId', optionalAuth, validateOrderId, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // If not admin, require email match to view order details
    let isFullDetail = false;
    if (!req.user || req.user.role !== 'admin') {
      const { email } = req.query;
      if (!email || email.toLowerCase() !== order.customer_email?.toLowerCase()) {
        if (req.user && req.user.role === 'customer' && (req.user.id === order.user_id || req.user.email?.toLowerCase() === order.customer_email?.toLowerCase())) {
          // Allow if customer is logged in and owns the order (either by ID or by email for guest legacy)
          isFullDetail = true;
        } else {
          return res.status(403).json({ success: false, message: 'Access denied' });
        }
      } else {
        // Email match means public URL with token/email pair
        isFullDetail = true;
      }
    } else {
      isFullDetail = true;
    }

    // GUEST ACCESS WINDOW: 20 minutes expiry for guest view
    const { email } = req.query;
    if (!req.user && email) {
      const createdAt = new Date(order.created_at);
      const diffMs = Date.now() - createdAt.getTime();
      const diffMins = diffMs / (1000 * 60);

      if (diffMins > 20) {
        return res.status(403).json({ 
          success: false,
          error: "Guest access window expired", 
          message: "For security, this order can no longer be viewed as a guest. Please sign in or create an account to view your order details.",
          expired: true
        });
      }
    }

    return res.json({
      success: true,
      order: _sanitizeOrder(order, isFullDetail)
    });

  } catch (err) {
    logger.error(`GET /api/orders/:orderId error: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Failed to fetch order' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/orders/:orderId/fulfill
//  Manually trigger fulfillment for a specific order (admin use).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:orderId/fulfill', requireAuth, requireRole('admin'), validateOrderId, async (req, res) => {
  try {
    const result = await fulfillOrder(req.params.orderId);
    return res.json({ success: true, result });
  } catch (err) {
    logger.error(`POST /api/orders/:orderId/fulfill error: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Retry a failed fulfillment (admin use).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:orderId/retry', requireAuth, requireRole('admin'), validateOrderId, async (req, res) => {
  try {
    const result = await retryFailedOrder(req.params.orderId);
    return res.json({ success: true, result });
  } catch (err) {
    logger.error(`POST /api/orders/:orderId/retry error: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/orders/:orderId/cancel-otp
//  Trigger a verification code for guest cancellation.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:orderId/cancel-otp', optionalAuth, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { email } = req.body; // Provided for guest or verification

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    
    let targetEmail = order.customer_email;
    let recipientType = 'Customer';

    // If admin is requesting, we might want to send OTP to the admin's email instead
    if (req.user && req.user.role === 'admin') {
      targetEmail = req.user.email;
      recipientType = 'Admin';
    } else if (req.user) {
      // Logged in customer
      targetEmail = req.user.email;
    } else {
      // Guest
      if (!email || email.toLowerCase() !== order.customer_email?.toLowerCase()) {
        return res.status(403).json({ success: false, message: 'Email does not match order record' });
      }

      // GUEST ACCESS WINDOW: 20 minutes expiry for guest cancellation
      const createdAt = new Date(order.created_at);
      const diffMs = Date.now() - createdAt.getTime();
      const diffMins = diffMs / (1000 * 60);

      if (diffMins > 20) {
        return res.status(403).json({ 
          success: false,
          error: "Guest cancellation window expired", 
          message: "The guest cancellation window has expired. Please sign in or create an account to manage your order.",
          expired: true
        });
      }

      targetEmail = email;
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    // Store OTP in the order record for verification
    await Order.updateOrder(orderId, {
      cancellation_otp: otp,
      cancellation_otp_expiry: expiry
    });

    const emailService = (await import('../services/emailService.js')).default;
    // We reuse the OTP email template
    await emailService.sendOTPEmail(targetEmail, otp, `Order Cancellation Verification (${recipientType})`);

    logger.info(`Cancellation OTP sent to ${targetEmail} for order ${order.order_number}`);

    return res.json({ success: true, message: `Verification code sent to ${targetEmail}` });
  } catch (err) {
    logger.error(`POST /api/orders/:orderId/cancel-otp error: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Failed to send verification code' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/orders/:orderId/cancel
//  Cancel an order, refund Shippo label if exists, restore stock.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:orderId/cancel', optionalAuth, validateOrderId, async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await Order.findById(orderId);

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const { email, otpCode, confirmed } = req.body;
    
    // ── 1. Authorization Check ──────────────────────────────────────────────
    let isAuthorized = false;
    
    if (req.user && req.user.role === 'admin') {
      isAuthorized = true;
    } else if (req.user && (req.user.id === order.user_id || req.user.email?.toLowerCase() === order.customer_email?.toLowerCase())) {
      isAuthorized = true;
    } else if (email && email.toLowerCase() === order.customer_email?.toLowerCase()) {
      isAuthorized = true;
    }

    if (!isAuthorized) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    // GUEST ACCESS WINDOW: 20 minutes expiry for guest cancellation finalization
    if (!req.user && email) {
      const createdAt = new Date(order.created_at);
      const diffMs = Date.now() - createdAt.getTime();
      const diffMins = diffMs / (1000 * 60);

      if (diffMins > 20) {
        return res.status(403).json({ 
          success: false,
          error: "Guest cancellation window expired", 
          message: "The guest cancellation window has expired. Please sign in or create an account to manage your order.",
          expired: true
        });
      }
    }

    // ── 2. OTP & Confirmation Check ──────────────────────────────────────────
    if (!otpCode) {
      return res.status(401).json({ success: false, message: 'Verification code required', requiresOtp: true });
    }

    if (order.cancellation_otp !== otpCode || new Date() > new Date(order.cancellation_otp_expiry)) {
      return res.status(401).json({ success: false, message: 'Invalid or expired verification code' });
    }

    if (!confirmed) {
      return res.json({ 
        success: true, 
        message: 'Verification code valid. Please confirm cancellation.', 
        requiresConfirmation: true 
      });
    }

    // Cleanup OTP after verification
    await Order.updateOrder(orderId, {
      cancellation_otp: null,
      cancellation_otp_expiry: null
    });


    // Check if order can be cancelled
    if (['shipped', 'delivered', 'cancelled', 'returned'].includes(order.fulfillment_status)) {
      return res.status(400).json({ success: false, message: `Order cannot be cancelled in current state: ${order.fulfillment_status}` });
    }

    // Special check for Amazon - if already submitted, we try to cancel there first
    if (order.fulfillment_channel === 'amazon_mcf' && order.amazon_fulfillment_id) {
        try {
            logger.info(`Attempting MCF cancellation for order ${order.order_number} (ID: ${order.amazon_fulfillment_id})`);
            const fulfillmentService = (await import('../services/fulfillmentService.js')).default;
            await fulfillmentService.cancelFulfillment(order.id);
            logger.info(`MCF cancellation successful for ${order.order_number}`);
        } catch (mcfErr) {
            const errMsg = mcfErr.response?.data?.message || mcfErr.message || '';
            logger.warn(`MCF Cancellation failed for ${order.order_number}: ${errMsg}`);
            
            if (errMsg.toLowerCase().includes('shipping') || errMsg.toLowerCase().includes('shipped')) {
                return res.status(400).json({ 
                  success: false, 
                  message: 'Order is already being shipped by Amazon and cannot be cancelled.' 
                });
            }
            // For other errors (like 404 for FAKE IDs), we log and proceed with local cancellation
        }
    }

    // 1. Refund Shippo Label if it was already created (Canada orders)
    if (order.shippo_transaction_id) {
       try {
         await shippoService.refundLabel(order.shippo_transaction_id);
         logger.info(`Shippo label refund requested for order ${order.order_number}`);
       } catch (refundErr) {
         logger.error(`Shippo refund request failed for order ${order.order_number}: ${refundErr.message}`);
       }
    }


    // 2. Restore Stock
    if (order.items && order.items.length > 0) {
      const restoreItems = order.items.map(i => ({
        product_id: i.product_id,
        variantId: i.product_variant_id,
        sku: i.sku,
        quantity: i.quantity
      }));
      await Product.restoreStock(restoreItems);
    }

    // 3. Update Order Status
    const actor = req.user ? (req.user.role === 'admin' ? 'Admin' : 'Customer') : 'Guest';
    await Order.updateOrder(orderId, {
      status: 'cancelled',
      fulfillment_status: 'cancelled',
      payment_status: order.payment_status === 'paid' ? 'refunded_pending' : 'cancelled',
      notes: (order.notes || '') + `\nOrder cancelled by ${actor} on ${new Date().toLocaleDateString()}`
    });

    return res.json({ success: true, message: 'Order cancelled successfully' });
  } catch (err) {
    logger.error(`POST /api/orders/:orderId/cancel error: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Failed to cancel order' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function _sanitizeOrder(order, isAdmin = false) {
  const base = {
    id: order.id,
    orderNumber: order.order_number,
    country: order.country,
    paymentStatus: order.payment_status,
    fulfillmentStatus: order.fulfillment_status,
    fulfillmentChannel: order.fulfillment_channel,
    trackingNumber: order.tracking_number,
    trackingUrl: order.tracking_url,
    carrier: order.carrier,
    estimatedDelivery: order.estimated_delivery,
    subtotal: order.subtotal,
    tax: order.tax,
    shippingCost: order.shipping_cost,
    total: order.total,
    currency: order.currency,
    createdAt: order.created_at,
    items: (order.items || []).map(i => ({
      sku: i.sku,
      productName: i.product_name,
      quantity: i.quantity,
      unitPrice: i.unit_price,
      totalPrice: i.total_price,
      image: i.fallback_image || i.image_url_at_purchase || i.image || null
    })),
    shipping: {
      name: `${order.shipping_first_name} ${order.shipping_last_name}`,
      city: order.shipping_city,
      state: order.shipping_state || order.shipping_province,
      zip: order.shipping_zip || order.shipping_postal_code,
      country: order.country
    }
  };

  if (isAdmin) {
    base.labelUrl = order.label_url;
    base.amazonFulfillmentId = order.amazon_fulfillment_id;
    base.fulfillmentError = order.fulfillment_error;
    base.customerEmail = order.customer_email;
    base.actualShippingCost = order.actual_shipping_cost;
    base.shippingProfitLoss = order.shipping_profit_loss;
    base.shippingFull = {
      address1: order.shipping_address1,
      address2: order.shipping_address2,
      phone: order.shipping_phone
    };
  }

  return base;
}

export default router;
