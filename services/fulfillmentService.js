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
  const mcfResult = await mcfService.createFulfillmentOrder(order);
  await _updateOrderStatus(order.id, { fulfillment_status: 'submitted_to_amazon', fulfillment_channel: 'amazon_mcf', amazon_fulfillment_id: mcfResult.sellerFulfillmentOrderId });
  logger.info(`US order ${order.order_number} submitted to Amazon MCF — ${mcfResult.sellerFulfillmentOrderId}`);
  await emailService.sendOrderConfirmationEmail(order, invoicePdf);
  return { success: true, fulfillmentChannel: 'amazon_mcf', status: 'submitted_to_amazon', amazonFulfillmentId: mcfResult.sellerFulfillmentOrderId };
}

async function _fulfillCA(order, invoicePdf = null) {
  logger.info(`Fulfilling CA order ${order.order_number} via Shippo`);
  const shipResult = await shippoService.createShipment(order);
  await _updateOrderStatus(order.id, { fulfillment_status: 'label_created', fulfillment_channel: 'shippo', tracking_number: shipResult.trackingNumber, tracking_url: shipResult.trackingUrl, label_url: shipResult.labelUrl, carrier: shipResult.carrier, service_name: shipResult.serviceName, estimated_delivery: shipResult.estimatedDays ? new Date(Date.now() + shipResult.estimatedDays * 86400000).toISOString().split('T')[0] : null, shippo_transaction_id: shipResult.shippoTransactionId });
  logger.info(`CA order ${order.order_number} label created — tracking: ${shipResult.trackingNumber}`);
  try { await shippoService.registerTracking(shipResult.carrier, shipResult.trackingNumber); } catch (trackErr) { logger.warn(`Shippo tracking registration failed (non-critical): ${trackErr.message}`); }
  await emailService.sendOrderConfirmationEmail(order, invoicePdf);
  await emailService.sendOrderShippedEmail(order, { carrier: shipResult.carrier, trackingNumber: shipResult.trackingNumber, trackingUrl: shipResult.trackingUrl, estimatedDelivery: shipResult.estimatedDays ? new Date(Date.now() + shipResult.estimatedDays * 86400000).toLocaleDateString() : null });
  return { success: true, fulfillmentChannel: 'shippo', status: 'label_created', trackingNumber: shipResult.trackingNumber, trackingUrl: shipResult.trackingUrl, labelUrl: shipResult.labelUrl, carrier: shipResult.carrier };
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
  const [orderRows] = await db.query(`SELECT o.*, u.email AS cust_email, u.first_name AS cust_first_name, u.last_name AS cust_last_name FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ?`, [orderId]);
  if (!orderRows.length) return null;
  const order = orderRows[0];
  const [itemRows] = await db.query(`SELECT * FROM order_items WHERE order_id = ?`, [orderId]);
  order.items = itemRows;
  return order;
}

async function _updateOrderStatus(orderId, fields) {
  const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(fields), new Date(), orderId];
  await db.query(`UPDATE orders SET ${setClauses}, updated_at = ? WHERE id = ?`, values);
}

export default { fulfillOrder, retryFailedOrder };
