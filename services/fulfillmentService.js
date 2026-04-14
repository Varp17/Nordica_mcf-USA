import db from '../config/database.js';
import mcfService from './mcfService.js';
import shippoService from './shippoService.js';
import emailService from './emailService.js';
import { createInvoiceFromOrder } from './invoiceService.js';
import logger from '../utils/logger.js';

export async function fulfillOrder(orderId) {
  const order = await _loadOrderWithItems(orderId);
  if (!order) throw new Error(`Order ${orderId} not found`);
  if (order.payment_status !== 'paid') throw new Error(`Order ${orderId} is not paid (status: ${order.payment_status})`);
  if (['shipped', 'delivered', 'submitted_to_amazon', 'label_created'].includes(order.fulfillment_status)) {
    logger.warn(`Order ${orderId} already fulfilled (status: ${order.fulfillment_status}) — skipping`);
    return { success: true, alreadyFulfilled: true, status: order.fulfillment_status };
  }
  await _updateOrderStatus(orderId, { fulfillment_status: 'processing' });
  
  // ── 0. Generate Invoice ───────────────────────────────────────────────
  let invoicePdf = null;
  try {
    const inv = await createInvoiceFromOrder(orderId);
    invoicePdf = inv.pdfPath;
  } catch (err) {
    logger.error(`Invoice generation failed for order ${orderId}: ${err.message}`);
    // Non-blocking: continue with fulfillment even if invoice fails
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
    await _updateOrderStatus(orderId, { fulfillment_status: 'fulfillment_error', fulfillment_error: err.message });
    await emailService.sendFulfillmentErrorAlert(order, err);
    logger.error(`Fulfillment failed for order ${orderId}:`, { error: err.message });
    throw err;
  }
}

async function _fulfillUS(order, invoicePdf = null) {
  logger.info(`Fulfilling US order ${order.order_number} via Amazon MCF`);

  // Edge Case: Final Amazon Inventory & Address Fulfillability check
  // (FBA stock might have changed since the customer was at checkout)
  try {
    const previews = await mcfService.getFulfillmentPreview({
      name:    `${order.shipping_first_name} ${order.shipping_last_name}`,
      line1:   order.shipping_address1,
      line2:   order.shipping_address2,
      city:    order.shipping_city,
      stateOrRegion: order.shipping_state || order.shipping_province,
      postalCode:    order.shipping_zip   || order.shipping_postal_code,
      phone:         order.shipping_phone
    }, order.items.map(i => ({ sku: i.sku, quantity: i.quantity })));

    const speed = order.shipping_speed?.toLowerCase() || 'standard';
    const activePreview = previews.find(p => p.shippingSpeedCategory.toLowerCase() === speed) || previews[0];

    if (!activePreview || !activePreview.isFulfillable) {
      throw new Error('MCF: Order is currently unfulfillable via Amazon (likely out of stock at FBA)');
    }
  } catch (prevErr) {
    logger.error('MCF: Pre-check failed for US order:', { order: order.order_number, error: prevErr.message });
    await _updateOrderStatus(order.id, { 
       fulfillment_status: 'inventory_hold', 
       fulfillment_error: prevErr.message 
    });
    return { success: false, status: 'inventory_hold', error: prevErr.message };
  }

  const mcfResult = await mcfService.createFulfillmentOrder(order);
  await _updateOrderStatus(order.id, { 
     fulfillment_status: 'submitted_to_amazon', 
     fulfillment_channel: 'amazon_mcf', 
     amazon_fulfillment_id: mcfResult.sellerFulfillmentOrderId,
     mcf_order_id: mcfResult.sellerFulfillmentOrderId
  });

  logger.info(`US order ${order.order_number} submitted to Amazon MCF — ${mcfResult.sellerFulfillmentOrderId}`);
  await emailService.sendOrderConfirmationEmail(order, invoicePdf);
  return { success: true, fulfillmentChannel: 'amazon_mcf', status: 'submitted_to_amazon', amazonFulfillmentId: mcfResult.sellerFulfillmentOrderId };
}

async function _fulfillCA(order, invoicePdf = null) {
  logger.info(`Fulfilling CA order ${order.order_number} via Shippo`);

  // ── 1. Pre-fulfillment Address Validation ──────────────────────────
  try {
    const validation = await shippoService.validateAddress({
      firstName: order.shipping_first_name,
      lastName:  order.shipping_last_name,
      address1:  order.shipping_address1,
      address2:  order.shipping_address2,
      city:      order.shipping_city,
      province:  order.shipping_province || order.shipping_state,
      postalCode: order.shipping_postal_code || order.shipping_zip,
      country:   'CA',
      phone:     order.shipping_phone,
      email:     order.cust_email
    });

    if (!validation.valid) {
      const errorMsg = Object.values(validation.fieldErrors).join(', ') || 'Invalid shipping address';
      throw new Error(`Shippo: Address validation failed — ${errorMsg}`);
    }
  } catch (valErr) {
    logger.error(`Shippo: Validation failed for order ${order.order_number}: ${valErr.message}`);
    await _updateOrderStatus(order.id, { 
       fulfillment_status: 'fulfillment_error', 
       fulfillment_error: valErr.message 
    });
    return { success: false, status: 'fulfillment_error', error: valErr.message };
  }

  // ── 2. Create Shipment & Buy Label ─────────────────────────────────
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

  logger.info(`CA order ${order.order_number} label created — tracking: ${shipResult.trackingNumber}`);

  // ── 3. Register for tracking webhooks ─────────────────────────────
  try { 
    await shippoService.registerTracking(shipResult.carrier, shipResult.trackingNumber); 
  } catch (trackErr) { 
    logger.warn(`Shippo tracking registration failed (non-critical): ${trackErr.message}`); 
  }

  // ── 4. Customer Notifications ─────────────────────────────────────
  await emailService.sendOrderConfirmationEmail(order, invoicePdf);
  await emailService.sendOrderShippedEmail(order, { 
    carrier: shipResult.carrier, 
    trackingNumber: shipResult.trackingNumber, 
    trackingUrl: shipResult.trackingUrl, 
    estimatedDelivery: shipResult.estimatedDays ? new Date(Date.now() + shipResult.estimatedDays * 86400000).toLocaleDateString() : null 
  });

  return { 
    success: true, 
    fulfillmentChannel: 'shippo', 
    status: 'label_created', 
    trackingNumber: shipResult.trackingNumber, 
    trackingUrl: shipResult.trackingUrl, 
    labelUrl: shipResult.labelUrl, 
    carrier: shipResult.carrier 
  };
}

export async function retryFailedOrder(orderId) {
  const [rows] = await db.query('SELECT fulfillment_status FROM orders WHERE id = ?', [orderId]);
  if (!rows.length) throw new Error(`Order ${orderId} not found`);
  const order = rows[0];
  if (order.fulfillment_status !== 'fulfillment_error') throw new Error(`Order ${orderId} is not in error state (status: ${order.fulfillment_status})`);
  await _updateOrderStatus(orderId, { fulfillment_status: 'paid', fulfillment_error: null });
  return fulfillOrder(orderId);
}

async function _loadOrderWithItems(orderId) {
  // 1. Fetch Order Metadata
  const [orderRows] = await db.query(`
    SELECT o.*, 
           u.email AS cust_email, 
           u.first_name AS cust_first_name, 
           u.last_name AS cust_last_name 
    FROM orders o 
    LEFT JOIN users u ON u.id = o.user_id 
    WHERE o.id = ?`, [orderId]);
  
  if (!orderRows.length) return null;
  const order = orderRows[0];

  // 2. Fetch Order Items with Product Metadata (Weight & Dimensions)
  // We join with products and variants to ensure accurate fulfillment (Shippo/MCF)
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

export default { fulfillOrder, retryFailedOrder };
