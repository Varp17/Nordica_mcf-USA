import db from '../config/database.js';
import mcfService from './mcfService.js';
import shippoService from './shippoService.js';
import emailService from './emailService.js';
import { createInvoiceFromOrder } from './invoiceService.js';
import logger from '../utils/logger.js';

/**
 * Main entry point for fulfilling an order.
 * Handles regional routing (US vs CA) and error recovery.
 */
export async function fulfillOrder(orderId) {
  // EDGE CASE #35: Reload with lock to ensure payment status is visible
  const order = await _loadOrderWithItems(orderId, true);
  
  if (!order) throw new Error(`Order ${orderId} not found`);
  
  if (order.payment_status !== 'paid') {
    logger.warn(`Order ${order.order_number} cannot be fulfilled: Payment status is ${order.payment_status}`);
    throw new Error(`Order ${orderId} is not paid`);
  }

  const terminalStatuses = ['shipped', 'delivered', 'submitted_to_amazon', 'label_created'];
  if (terminalStatuses.includes(order.fulfillment_status)) {
    logger.warn(`Order ${orderId} already fulfilled/submitted (status: ${order.fulfillment_status}) — skipping`);
    return { success: true, alreadyFulfilled: true, status: order.fulfillment_status };
  }

  await _updateOrderStatus(orderId, { fulfillment_status: 'processing', fulfillment_error: null });
  
  // ── 0. Generate Invoice ───────────────────────────────────────────────
  let invoicePdf = null;
  try {
    const inv = await createInvoiceFromOrder(orderId);
    invoicePdf = inv.pdfPath;
  } catch (err) {
    logger.error(`Invoice generation failed for order ${orderId}: ${err.message}`);
  }

  try {
    let result;
    if (order.country === 'US') {
      result = await _fulfillUS(order, invoicePdf);
    } else if (order.country === 'CA') {
      result = await _fulfillCA(order, invoicePdf);
    } else {
      throw new Error(`Unsupported fulfillment country: ${order.country}`);
    }
    return result;
  } catch (err) {
    logger.error(`Fulfillment failed for order ${orderId}: ${err.message}`, { stack: err.stack });
    await _updateOrderStatus(orderId, { fulfillment_status: 'fulfillment_error', fulfillment_error: err.message });
    
    // Alert admin
    emailService.sendFulfillmentErrorAlert(order, err).catch(e => logger.error("Fulfillment Alert Failure", e));
    
    throw err;
  }
}

/**
 * US Fulfillment Logic (Amazon MCF)
 */
async function _fulfillUS(order, invoicePdf = null) {
  logger.info(`Fulfilling US order ${order.order_number} via Amazon MCF`);

  // Pre-fulfillment validation
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
    const activePreview = previews.find(p => p.shippingSpeedCategory.toLowerCase() === speed) || previews[0];

    if (!activePreview || !activePreview.isFulfillable) {
       // Check if it's just a speed mismatch or total unfulfillability
       const anyFulfillable = previews.some(p => p.isFulfillable);
       if (!anyFulfillable) {
         throw new Error('MCF: Order is currently unfulfillable (Inventory Check Failed)');
       }
       logger.warn(`Speed ${speed} not available for ${order.order_number}, falling back to available MCF speed.`);
    }
  } catch (prevErr) {
    logger.error(`MCF Pre-check Error for ${order.order_number}: ${prevErr.message}`);
    // Don't block yet, try submission anyway as previews can be flaky
  }

  // Submit to Amazon
  const mcfResult = await mcfService.createFulfillmentOrder(order);
  
  const actualCost = activePreview?.totalFee || 0;
  const chargedToCustomer = parseFloat(order.shipping_cost || 0);
  const profitLoss = parseFloat((chargedToCustomer - actualCost).toFixed(2));

  // Sustainability Warning
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

  logger.info(`US order ${order.order_number} submitted to Amazon MCF. Loss/Profit: ${profitLoss} | Amazon Fee: ${actualCost}`);
  
  // Notifications
  await emailService.sendOrderConfirmationEmail(order, invoicePdf).catch(e => logger.error("Confirmation Email Error", e));
  
  return { success: true, fulfillmentChannel: 'amazon_mcf', status: 'submitted_to_amazon', amazonFulfillmentId: mcfResult.sellerFulfillmentOrderId };
}

/**
 * CA Fulfillment Logic (Shippo)
 */
async function _fulfillCA(order, invoicePdf = null) {
  logger.info(`Fulfilling CA order ${order.order_number} via Shippo`);

  // Address Validation
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

  if (!validation.valid) {
    const errorMsg = Object.values(validation.fieldErrors || {}).join(', ') || 'Invalid shipping address';
    throw new Error(`Address validation failed: ${errorMsg}`);
  }

  // Create Shipment & Buy Label
  const shipResult = await shippoService.createShipment(order);
  
  await _updateOrderStatus(order.id, {
    fulfillment_status: 'label_created',
    fulfillment_channel: 'shippo',
    shippo_tracking_number: shipResult.trackingNumber,
    shippo_carrier: shipResult.carrier,
    shippo_tracking_status: 'PRE_TRANSIT',
    shippo_label_url: shipResult.labelUrl,
    service_name: shipResult.serviceName,
    estimated_delivery: shipResult.estimatedDays ? new Date(Date.now() + shipResult.estimatedDays * 86400000).toISOString().split('T')[0] : null,
    shippo_transaction_id: shipResult.shippoTransactionId
  });

  // Track & Notify
  try { await shippoService.registerTracking(shipResult.carrier, shipResult.trackingNumber); } catch (e) {}

  await emailService.sendOrderConfirmationEmail(order, invoicePdf).catch(e => logger.error("Conf email err", e));
  
  await emailService.sendOrderShippedEmail(order, { 
    carrier: shipResult.carrier, 
    trackingNumber: shipResult.trackingNumber, 
    trackingUrl: shipResult.trackingUrl, 
    estimatedDelivery: shipResult.estimatedDays ? new Date(Date.now() + shipResult.estimatedDays * 86400000).toLocaleDateString() : '3-7 business days' 
  }).catch(e => logger.error("Ship email err", e));

  return { success: true, fulfillmentChannel: 'shippo', status: 'label_created' };
}

/**
 * Retries a failed order submission
 */
export async function retryFailedOrder(orderId) {
  const [rows] = await db.query('SELECT fulfillment_status FROM orders WHERE id = ?', [orderId]);
  if (!rows.length) throw new Error('Order not found');
  
  if (rows[0].fulfillment_status !== 'fulfillment_error' && rows[0].fulfillment_status !== 'inventory_hold') {
      throw new Error(`Cannot retry order in status ${rows[0].fulfillment_status}`);
  }

  // EDGE CASE #38: Set to processing/pending, not 'paid'
  await _updateOrderStatus(orderId, { fulfillment_status: 'pending', fulfillment_error: null });
  return fulfillOrder(orderId);
}

/**
 * Loads order metadata and items with fulfillment specifics
 * EDGE CASE #69: Fallback for guest email
 */
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
    SELECT oi.*, 
           COALESCE(v.weight_kg, p.weight_kg, 0.5) as weight_kg,
           COALESCE(v.dimensions, p.dimensions, '20x15x10') as dimensions,
           COALESCE(pcv.amazon_sku, v.sku, oi.sku) as actual_sku
    FROM order_items oi
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

/**
 * Attempt to cancel fulfillment at the provider level (Amazon or Shippo)
 */
export async function cancelFulfillment(orderId) {
  const order = await _loadOrderWithItems(orderId);
  if (!order) throw new Error('Order not found');

  if (order.country === 'US' && order.amazon_fulfillment_id) {
    logger.info(`Attempting to cancel Amazon MCF order: ${order.amazon_fulfillment_id}`);
    await mcfService.cancelFulfillmentOrder(order.amazon_fulfillment_id);
    return { success: true, channel: 'amazon_mcf' };
  }
  
  // Shippo cancellation is non-trivial (often requires refunding labels)
  if (order.country === 'CA' && order.shippo_transaction_id) {
    logger.warn(`Shippo cancellation requested for ${orderId}. Labels may need manual refund.`);
    // We could potentially call shippoService.refundLabel(order.shippo_transaction_id);
  }

  return { success: true };
}

export default { fulfillOrder, retryFailedOrder, cancelFulfillment };
