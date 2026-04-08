import express from 'express';
import db from '../config/database.js';
import Order from '../models/Order.js';
import Customer from '../models/Customer.js';
import * as Product from '../models/Product.js';
import { fulfillOrder, retryFailedOrder } from '../services/fulfillmentService.js';
import mcfService from '../services/mcfService.js';
import shippoService from '../services/shippoService.js';
import { authenticateToken as requireAuth, requireAdmin, requireVerified, optionalAuth } from '../middleware/auth.js';
import { validateCreateOrder, validateOrderId } from '../middleware/validation.js';
import { detectCountryFromRequest } from '../utils/helpers.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Compatibility: requireRole('admin') -> requireAdmin
const requireRole = (role) => (role === 'admin' ? requireAdmin : (req, res, next) => next());
const optionalAuthStub = (req, res, next) => next(); // Deprecated, using real optionalAuth

/**
 * Order Routes
 * ─────────────
 * POST   /api/orders                 — Create a new order (after payment)
 * GET    /api/orders/:orderId        — Get order details (customer-facing)
 * GET    /api/orders/number/:number  — Get by order number
 * GET    /api/orders/my              — Get authenticated customer's orders
 * POST   /api/orders/:orderId/retry  — Retry failed fulfillment (admin)
 */

// const express = require('express');
// const router = express.Router();
// const db = require('../config/database');
// const Order = require('../models/Order');
// const Customer = require('../models/Customer');
// const Product = require('../models/Product');
// const { fulfillOrder, retryFailedOrder } = require('../services/fulfillmentService');
// const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
// const { validateCreateOrder, validateOrderId } = require('../middleware/validation');
// const { detectCountryFromRequest } = require('../utils/helpers');
// const logger = require('../utils/logger');

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
    const { valid, errors, items: validatedItems } = await Product.validateCartItems(items, country);

    if (!valid) {
      return res.status(400).json({ success: false, message: 'Cart validation failed', errors });
    }

    // Ensure all items match the order's country (normalized)
    if (validatedItems.some(i => {
      let normalized = i.country;
      if (normalized === 'USA') normalized = 'US';
      if (normalized === 'CAD') normalized = 'CA';
      return normalized !== country;
    })) {
      return res.status(400).json({ success: false, message: `Some items in your cart are not available for ${country}` });
    }

    // ── 2. Find or create customer ────────────────────────────────────────────
    const customer = await Customer.findOrCreate({
      email,
      firstName: shipping.firstName,
      lastName: shipping.lastName,
      phone: shipping.phone,
      country
    });

    // Use the found/created customer ID
    customerId = customer.id;

    // ── 3. Create order in DB ─────────────────────────────────────────────────
    const order = await Order.createOrder({
      customerId: customer.id,
      country,
      items: validatedItems,
      shipping,
      shippingSpeed: shippingSpeed || 'standard',
      paymentMethod,
      paymentReference,
      paymentStatus: 'paid',
      subtotal: parseFloat(subtotal),
      tax: parseFloat(tax || 0),
      shippingCost: parseFloat(shippingCost || 0),
      total: parseFloat(total),
      currency: currency || (country === 'CA' ? 'CAD' : 'USD'),
      notes
    });

    // ── 4. Mark as paid ───────────────────────────────────────────────────────
    await Order.updatePaymentStatus(order.id, {
      paymentStatus: 'paid',
      paymentReference,
      paymentMethod
    });

    // ── 5. Trigger fulfillment & Invoice (async — don't block the response) ─────────────
    // We respond to the customer immediately, then fulfill & generate invoice in background
    fulfillOrder(order.id).catch((err) => {
      logger.error(`Background fulfillment failed for order ${order.id}: ${err.message}`);
    });

    logger.info(`Order created: ${order.order_number} | Country: ${country} | Total: ${total}`);

    logger.info(`Order created: ${order.order_number} | Country: ${country} | Total: ${total}`);

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

    // 2. Fetch rates based on country
    if (country === 'US') {
      // ── MCF Preview is the PRIMARY pricing authority ──
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
        
        // Use ALL fulfillable rates from Amazon directly — no markup
        rates = previews
          .filter(p => p.isFulfillable)
          .map(p => {
            const earliest = p.fulfillmentPreviewShipments?.[0]?.earliestArrival;
            const latest = p.fulfillmentPreviewShipments?.[0]?.latestArrival;
            
            let estDays = '';
            if (earliest && latest) {
              const daysStart = Math.max(1, Math.ceil((new Date(earliest) - new Date()) / (1000 * 60 * 60 * 24)));
              const daysEnd = Math.max(1, Math.ceil((new Date(latest) - new Date()) / (1000 * 60 * 60 * 24)));
              estDays = `Estimated ${daysStart}-${daysEnd} business days`;
            }

            return {
              id: p.shippingSpeedCategory.toLowerCase(),
              name: `${p.shippingSpeedCategory} Shipping`,
              price: p.totalFee,    // Amazon's exact price — no buffer
              currency: p.currency || 'USD',
              estimation: estDays || 'Fast & Reliable Delivery',
              isFulfillable: true
            };
          });

      } catch (mcfErr) {
        logger.error(`MCF Preview Error: ${mcfErr.message}`);
      }

      // FALLBACK: Manual calculator only if MCF returned nothing
      if (rates.length === 0) {
        logger.info('shipping-rates: MCF unavailable, using manual fallback');
        const manualResult = mcfService.calculateManualEstimate(validatedItems);
        rates = [{
          id: 'standard',
          name: 'Standard Shipping',
          price: manualResult[0]?.totalFee || 9.99,
          currency: 'USD',
          estimation: 'Estimated 5-7 business days (offline estimate)',
          isFulfillable: true
        }];
      }
    } else if (country === 'CA') {
      try {
        const shippoRates = await shippoService.getShippingRates({
          shipping_first_name: shipping?.firstName,
          shipping_last_name: shipping?.lastName,
          shipping_address1: shipping?.address1,
          shipping_address2: shipping?.address2,
          shipping_city: shipping?.city,
          shipping_province: shipping?.province || shipping?.state,
          shipping_postal_code: shipping?.postalCode || shipping?.zip,
          items: validatedItems
        });

        rates = shippoRates.map(r => ({
          id: r.rateId,
          name: r.serviceName,
          price: r.amount,
          currency: r.currency,
          estimation: r.estimatedDays ? `Estimated ${r.estimatedDays} business days` : (r.durationTerms || 'Standard Shipping'),
          isFulfillable: true
        }));
      } catch (shippoErr) {
        logger.error(`Shippo Preview Error: ${shippoErr.message}`);
        // Fallback for CA
        rates = [{
          id: 'standard',
          name: 'Standard Shipping',
          price: 15.00,
          currency: 'CAD',
          estimation: 'Estimated 6-10 business days',
          isFulfillable: true
        }];
      }
    }

    return res.json({ success: true, rates });
  } catch (err) {
    logger.error(`POST /api/orders/shipping-rates error: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Failed to fetch shipping rates' });
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
        if (req.user && req.user.role === 'customer' && req.user.id === order.customer_id) {
          // Allow if customer is logged in and owns the order
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

    return res.json({ success: true, order: _sanitizeOrder(order) });

  } catch (err) {
    logger.error(`GET /api/orders/number/:orderNumber error: ${err.message}`);
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
//  POST /api/orders/:orderId/retry
//  Retry a failed fulfillment (admin use).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:orderId/retry', requireAuth, requireRole('admin'), validateOrderId, async (req, res) => {
  try {
    const result = await retryFailedOrder(req.params.orderId);
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/orders/:orderId/cancel
//  Cancel an order, refund Shippo label if exists, restore stock.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:orderId/cancel', requireAuth, validateOrderId, async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await Order.findById(orderId);

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Authorization: Admin or the customer who owns the order
    if (req.user.role !== 'admin' && req.user.id !== order.user_id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    // Check if order can be cancelled
    if (['shipped', 'delivered', 'cancelled', 'returned'].includes(order.fulfillment_status)) {
      return res.status(400).json({ success: false, message: `Order cannot be cancelled in current state: ${order.fulfillment_status}` });
    }

    // 1. Refund Shippo Label if it was already created (Canada orders)
    if (order.shippo_transaction_id) {
       try {
         await shippoService.refundLabel(order.shippo_transaction_id);
         logger.info(`Shippo label refund requested for order ${order.order_number}`);
       } catch (refundErr) {
         logger.error(`Shippo refund request failed for order ${order.order_number}: ${refundErr.message}`);
         // Non-blocking: we continue with order cancellation
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
    await Order.updateOrder(orderId, {
      status: 'cancelled',
      fulfillment_status: 'cancelled',
      payment_status: order.payment_status === 'paid' ? 'refunded_pending' : 'cancelled',
      notes: (order.notes || '') + `\nOrder cancelled by ${req.user.role === 'admin' ? 'Admin' : 'Customer'} on ${new Date().toLocaleDateString()}`
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
      totalPrice: i.total_price
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
    base.shippingFull = {
      address1: order.shipping_address1,
      address2: order.shipping_address2,
      phone: order.shipping_phone
    };
  }

  return base;
}

export default router;
