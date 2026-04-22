import db from '../config/database.js';
import mcfService from './mcfService.js';
import shippoService from './shippoService.js';
import emailService from './emailService.js';
// import { createInvoiceFromOrder } from './invoiceService.js'; // Removed: handled by payment/order routes
import logger from '../utils/logger.js';
import Product from '../models/Product.js';

/**
 * Main entry point for fulfilling an order.
 * Handles regional routing (US vs CA) and error recovery.
 */
export async function fulfillOrder(orderId) {
  const order = await _loadOrderWithItems(orderId, true);
  
  if (!order) throw new Error(`Order ${orderId} not found`);
  
  if (order.payment_status !== 'paid') {
    logger.warn(`Order ${order.order_number} cannot be fulfilled: Payment status is ${order.payment_status}`);
    throw new Error(`Order ${orderId} is not paid`);
  }

  // Mandatory PayPal Verification Check
  if (order.payment_method === 'paypal' && !order.is_paypal_verified) {
    // Only block if bypass flag is NOT set
    if (process.env.PAYPAL_BYPASS_VERIFICATION !== 'true') {
      logger.warn(`Order ${order.order_number} cannot be fulfilled: PayPal account NOT verified.`);
      await _updateOrderStatus(orderId, { 
        fulfillment_status: 'on_hold_verification', 
        fulfillment_error: 'PayPal account not verified. Please contact support or use a verified account.' 
      });
      return { success: false, message: 'PayPal verification required', status: 'on_hold_verification' };
    } else {
      logger.info(`Order ${order.order_number}: PayPal verification check bypassed via environment flag.`);
    }
  }

  const terminalStatuses = ['shipped', 'delivered', 'submitted_to_amazon', 'label_created'];
  if (terminalStatuses.includes(order.fulfillment_status)) {
    // If the order is already submitted/shipped but we are missing the cost, 
    // we allow it to proceed to capture the cost if this is a manual retry or repair.
    if (order.actual_shipping_cost && parseFloat(order.actual_shipping_cost) > 0) {
      logger.warn(`Order ${orderId} already fulfilled/submitted with cost — skipping`);
      return { success: true, alreadyFulfilled: true, status: order.fulfillment_status };
    }
    logger.info(`Order ${orderId} is in terminal status (${order.fulfillment_status}) but missing cost. Permitting re-processing to capture metrics.`);
  }

  // Safety Check: Do not attempt to fulfill an order with no items
  if (!order.items || order.items.length === 0) {
    logger.error(`Order ${order.order_number} has no items. Skipping fulfillment.`);
    await _updateOrderStatus(orderId, { 
      fulfillment_status: 'fulfillment_error', 
      fulfillment_error: 'Critical Error: Order has no items in database.' 
    });
    return { success: false, message: 'Order has no items' };
  }

  // Invoice generation is now handled asynchronously in routes/payment.js or routes/orderRoutes.js

  // MOCK FULFILLMENT: If the order number contains "FAKE", we do not hit real logistics APIs.
  if (order.order_number.includes('FAKE')) {
    logger.info(`Mock Fulfillment: Detected test order ${order.order_number}. Skipping real logistics.`);
    
    // Simulate a successful submission to a mock channel
    await _updateOrderStatus(orderId, { 
       fulfillment_status: 'submitted_to_mock', 
       fulfillment_channel: 'mock_provider',
       notes: (order.notes || '') + '\nOrder processed via Mock Fulfillment (Test Mode).'
    });

    await emailService.sendFulfillmentOrderSubmittedEmail(order).catch(e => logger.error("Submit email err", e));
    return { success: true, fulfillmentChannel: 'mock_provider', status: 'submitted_to_mock' };
  }

  try {
    let result;
    if (order.country === 'US') {
      result = await _fulfillUS(order);
    } else if (order.country === 'CA') {
      result = await _fulfillCA(order);
    } else {
      throw new Error(`Unsupported fulfillment country: ${order.country}`);
    }
    return result;
  } catch (err) {
    logger.error(`Fulfillment failed for order ${orderId}: ${err.message}`, { stack: err.stack });
    await _updateOrderStatus(orderId, { fulfillment_status: 'fulfillment_error', fulfillment_error: err.message });
    emailService.sendFulfillmentErrorAlert(order, err).catch(e => logger.error("Fulfillment Alert Failure", e));
    throw err;
  }
}

async function _fulfillUS(order, invoicePdf = null) {
  logger.info(`Fulfilling US order ${order.order_number} via Amazon MCF`);
  let activePreview = null;
  try {
    const address = {
      name:    `${order.shipping_first_name} ${order.shipping_last_name}`,
      line1:   order.shipping_address1,
      line2:   order.shipping_address2,
      city:    order.shipping_city,
      stateOrRegion: order.shipping_state || order.shipping_province,
      postalCode:    order.shipping_zip   || order.shipping_postal_code,
      phone:         order.shipping_phone,
      countryCode:   'US'
    };
    const previews = await mcfService.getFulfillmentPreview(address, order.items.map(i => ({ sku: i.actual_sku || i.sku, quantity: i.quantity })));
    const speed = order.shipping_speed?.toLowerCase() || 'standard';
    activePreview = previews.find(p => p.shippingSpeedCategory.toLowerCase() === speed) || previews[0];
  } catch (prevErr) {
    logger.error(`MCF Pre-check Error for ${order.order_number}: ${prevErr.message}`);
  }

  const mcfResult = await mcfService.createFulfillmentOrder(order);
  const actualCost = activePreview?.totalFee || 0;
  const chargedToCustomer = parseFloat(order.shipping_cost || 0);
  const profitLoss = parseFloat((chargedToCustomer - actualCost).toFixed(2));

  if (profitLoss < -8.00) {
    logger.warn(`[SUSTAINABILITY ALERT] Order ${order.order_number} has high shipping loss: $${Math.abs(profitLoss)}! (Amazon: ${actualCost}, Customer: ${chargedToCustomer})`);
  }

  await _updateOrderStatus(order.id, { 
     fulfillment_status: 'submitted_to_amazon', 
     fulfillment_channel: 'amazon_mcf', 
     amazon_fulfillment_id: mcfResult.sellerFulfillmentOrderId,
     mcf_order_id: mcfResult.sellerFulfillmentOrderId,
     actual_shipping_cost: actualCost,
     shipping_profit_loss: profitLoss
  });
  
  await emailService.sendFulfillmentOrderSubmittedEmail(order).catch(e => logger.error("Submit email err", e));

  // Confirmation email is now handled in routes via invoiceService
  // await emailService.sendOrderConfirmationEmail(order, invoicePdf).catch(e => logger.error("Confirmation Email Error", e));
  return { success: true, fulfillmentChannel: 'amazon_mcf', status: 'submitted_to_amazon', amazonFulfillmentId: mcfResult.sellerFulfillmentOrderId };
}

async function _fulfillCA(order, invoicePdf = null) {
  logger.info(`Fulfilling CA order ${order.order_number} via Shippo`);
  const validation = await shippoService.validateAddress({
    firstName: order.shipping_first_name,
    lastName:  order.shipping_last_name,
    address1:  order.shipping_address1,
    city:      order.shipping_city,
    province:  order.shipping_province || order.shipping_state,
    postalCode: order.shipping_postal_code || order.shipping_zip,
    country:   'CA',
    phone:     order.shipping_phone
  });
  if (!validation.valid) throw new Error('Address validation failed');

  let actualCost = 0;
  try {
    const rates = await shippoService.getShippingRates(order);
    const bestRate = rates[0]; // Shippo returns them sorted cheapest first
    if (bestRate) actualCost = parseFloat(bestRate.amount);
  } catch (rateErr) {
    logger.warn(`Failed to fetch actual Shippo cost during CA fulfillment: ${rateErr.message}`);
  }

  const chargedToCustomer = parseFloat(order.shipping_cost || 0);
  const profitLoss = parseFloat((chargedToCustomer - actualCost).toFixed(2));

  const shipResult = await shippoService.createOrder(order);

  await _updateOrderStatus(order.id, {
    fulfillment_status: 'submitted_to_shippo',
    fulfillment_channel: 'shippo',
    shippo_order_id: shipResult.shippoOrderId,
    actual_shipping_cost: actualCost,
    shipping_profit_loss: profitLoss,
    notes: (order.notes || '') + `\nShippo Order created. Selected Carton: ${shipResult.selectedCarton}`
  });
  
  await emailService.sendFulfillmentOrderSubmittedEmail(order).catch(e => logger.error("Submit email err", e));
  return { success: true, fulfillmentChannel: 'shippo', status: 'submitted_to_shippo' };
}

export async function retryFailedOrder(orderId) {
  const [rows] = await db.query('SELECT fulfillment_status FROM orders WHERE id = ?', [orderId]);
  if (!rows.length) throw new Error('Order not found');
  if (rows[0].fulfillment_status !== 'fulfillment_error' && rows[0].fulfillment_status !== 'inventory_hold') {
      throw new Error(`Cannot retry order in status ${rows[0].fulfillment_status}`);
  }
  await _updateOrderStatus(orderId, { fulfillment_status: 'pending', fulfillment_error: null });
  return fulfillOrder(orderId);
}

async function _loadOrderWithItems(orderId, lock = false) {
  const sql = `
    SELECT o.*, 
           COALESCE(u.email, o.customer_email) AS cust_email, 
           COALESCE(u.first_name, o.shipping_first_name) AS cust_first_name, 
           COALESCE(u.last_name, o.shipping_last_name) AS cust_last_name 
    FROM orders o 
    LEFT JOIN users u ON u.id = o.user_id 
    WHERE o.id = ? ${lock ? 'FOR UPDATE' : ''}`;
  const [orderRows] = await db.query(sql, [orderId]);
  if (!orderRows.length) return null;
  const order = orderRows[0];
  const [itemRows] = await db.query(`
    SELECT oi.*, p.slug,
           COALESCE(v.weight_kg, pcv.weight_kg, p.weight_kg, 0.5) as weight_kg,
           COALESCE(v.dimensions, pcv.dimensions, p.dimensions, '20x15x10') as dimensions,
           CASE 
             WHEN o.country = 'CA' THEN COALESCE(v.canada_sku, pcv.canada_sku, v.sku, oi.sku)
             ELSE COALESCE(v.amazon_sku, pcv.amazon_sku, v.sku, oi.sku)
           END as actual_sku
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    LEFT JOIN products p ON oi.product_id = p.id
    LEFT JOIN product_variants v ON oi.product_variant_id = v.id
    LEFT JOIN product_color_variants pcv ON oi.product_variant_id = pcv.id
    WHERE oi.order_id = ?`, [orderId]);
  order.items = itemRows;
  return order;
}

async function _updateOrderStatus(orderId, fields) {
  const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(fields), new Date(), orderId];
  await db.query(`UPDATE orders SET ${setClauses}, updated_at = ? WHERE id = ?`, values);
}

export async function cancelFulfillment(orderId) {
  const order = await _loadOrderWithItems(orderId);
  if (!order) throw new Error('Order not found');
  if (order.country === 'US' && order.amazon_fulfillment_id) {
    await mcfService.cancelFulfillmentOrder(order.amazon_fulfillment_id);
    return { success: true, channel: 'amazon_mcf' };
  }
  return { success: true };
}

export async function getProjectedSustainability(country, address, items, customerCharged) {
  try {
    // RESOLVE SKUs before probing (Crucial for Amazon MCF quotes)
    const { valid, items: validatedItems } = await Product.validateCartItems(items, country);
    const probeItems = valid ? validatedItems : items;

    let actualCost = 0;
    if (country === 'US') {
      try {
        if (!probeItems || probeItems.length === 0) {
           return { actual_shipping_cost: 0, shipping_profit_loss: 0 };
        }
        const mcfItems = probeItems.map(i => ({ 
           sku: i.sellerSku || i.sku || i.productId || i.product_id, 
           quantity: i.quantity 
        }));
        const mcfAddress = {
          name: address.firstName + ' ' + (address.lastName || ''),
          line1: address.address1 || address.address,
          city: address.city,
          stateOrRegion: address.state || address.province,
          postalCode: address.zip || address.postalCode,
          phone: address.phone || '0000000000',
          countryCode: 'US'
        };
        const previews = await mcfService.getFulfillmentPreview(mcfAddress, mcfItems);
        const speed = (address.shippingSpeed || 'standard').toLowerCase();
        const bestMatch = previews.find(p => p.shippingSpeedCategory.toLowerCase() === speed) || previews[0];
        actualCost = bestMatch?.totalFee || 0;
      } catch (err) {
        logger.error(`MCF Projection Fail: ${err.message}`);
        actualCost = 6.50; 
      }
    } else if (country === 'CA') {
      try {
        const rates = await shippoService.getShippingRates({
            items: probeItems,
            shipping_address: address,
            shipping_first_name: address.firstName,
            shipping_last_name: address.lastName,
            shipping_address1: address.address1 || address.address,
            shipping_city: address.city,
            shipping_province: address.province || address.state,
            shipping_postal_code: address.postalCode || address.zip
        });
        const bestRate = rates.find(r => r.object_id === address.rateId) || rates[0];
        actualCost = parseFloat(bestRate?.amount || 0);
      } catch (err) {
        logger.error(`Shippo Projection Fail: ${err.message}`);
        actualCost = 12.00;
      }
    }
    const profitLoss = parseFloat((customerCharged - actualCost).toFixed(2));
    return { actual_shipping_cost: actualCost, shipping_profit_loss: profitLoss };
  } catch (err) {
    logger.error(`Sustainability Projection Error: ${err.message}`);
    return { actual_shipping_cost: 0, shipping_profit_loss: 0 };
  }
}

export default { fulfillOrder, retryFailedOrder, cancelFulfillment, getProjectedSustainability };
