'use strict';

/**
 * Amazon Multi-Channel Fulfillment (MCF) Service
 * ────────────────────────────────────────────────
 * Wraps the SP-API Fulfillment Outbound (2020-07-01) endpoints:
 *
 *  POST   /fba/outbound/2020-07-01/fulfillmentOrders          → createFulfillmentOrder
 *  GET    /fba/outbound/2020-07-01/fulfillmentOrders/{id}     → getFulfillmentOrder
 *  GET    /fba/outbound/2020-07-01/fulfillmentOrderItems      → listItems
 *  PUT    /fba/outbound/2020-07-01/fulfillmentOrders/{id}     → cancelFulfillmentOrder
 *  POST /fba/outbound/2020-07-01/fulfillmentOrders/preview         → getFulfillmentPreview (rate check)
 */


import { spApiRequest } from './spApiClient.js';
import { generateMCFOrderId } from '../utils/helpers.js';
import logger from '../utils/logger.js';
import { normalizeState } from '../utils/state-normalization.js';
import { calculateMCFShipping } from '../utils/shippingCalculator.js';

const MCF_BASE = '/fba/outbound/2020-07-01';

const SPEED_MAP = {
  standard:  'Standard',
  expedited: 'Expedited',
  priority:  'Priority',
  scheduled: 'ScheduledDelivery'
};

/**
 * Truncate and sanitize fields for Amazon MCF
 * MCF has very strict length limits and character requirements.
 */
function sanitizeMCFField(str, maxLen = 50) {
  return (str || '').toString().trim().substring(0, maxLen);
}

/**
 * Amazon MCF is extremely picky about phone number formats.
 * It strictly expects a 1-20 character string, usually digits and + only.
 * EDGE CASE #77: Phone number sanitation
 */
function sanitizeMCFPhone(phone) {
  if (!phone) return '';
  // Remove spaces, parentheses, dashes. Keep digits and leading +.
  let clean = phone.replace(/[^\d+]/g, '');
  if (clean.length > 20) clean = clean.substring(0, 20);
  return clean || '1234567890'; // Amazon requires a phone number
}

/**
 * POST /fba/outbound/2020-07-01/fulfillmentOrders
 * Create a new fulfillment order in Amazon.
 */
export async function createFulfillmentOrder(order) {
  const sellerFulfillmentOrderId = generateMCFOrderId(order.order_number);
  const shippingSpeed = SPEED_MAP[order.shipping_speed?.toLowerCase()] || 'Standard';

  // EDGE CASE #78: Normalize state to 2-letter code
  const state = normalizeState(order.shipping_state || order.shipping_province || '');

  const payload = {
    marketplaceId:             process.env.AMAZON_MARKETPLACE_ID_US || 'ATVPDKIKX0DER',
    sellerFulfillmentOrderId,
    displayableOrderId:        order.order_number,
    displayableOrderDate:      new Date(order.created_at).toISOString(),
    displayableOrderComment:   sanitizeMCFField(`Order Nordica Ecom #${order.order_number}`, 250),
    shippingSpeedCategory:     shippingSpeed,
    destinationAddress: {
      name:                sanitizeMCFField(`${order.shipping_first_name} ${order.shipping_last_name}`, 50),
      addressLine1:        sanitizeMCFField(order.shipping_address1, 60),
      addressLine2:        sanitizeMCFField(order.shipping_address2 || '', 60),
      city:                sanitizeMCFField(order.shipping_city, 50),
      stateOrRegion:       sanitizeMCFField(state, 150),
      postalCode:          sanitizeMCFField(order.shipping_zip || order.shipping_postal_code, 20),
      countryCode:         'US',
      phone:               sanitizeMCFPhone(order.shipping_phone)
    },
    items: (order.items || []).map((item, idx) => ({
      // EDGE CASE #79: Trim SKUs
      sellerSku:                    (item.actual_sku || item.sku || '').trim(),
      sellerFulfillmentOrderItemId: `${sellerFulfillmentOrderId}-${idx + 1}`,
      quantity:                     item.quantity,
      displayableComment:           sanitizeMCFField(item.product_name || 'Product', 250),
      perUnitDeclaredValue: {
        currencyCode: 'USD',
        value:        String(parseFloat(item.unit_price || 0).toFixed(2))
      }
    })),
    notificationEmails: [order.customer_email || order.cust_email].filter(Boolean),
    featureConstraints: []
  };

  logger.info(`MCF: Creating order for #${order.order_number} (${sellerFulfillmentOrderId})`);

  try {
    await spApiRequest('POST', `${MCF_BASE}/fulfillmentOrders`, payload);
    return { success: true, sellerFulfillmentOrderId };
  } catch (err) {
    const errorData = err.response?.data?.errors?.[0];
    if (err.response?.status === 400 && errorData?.message?.includes('already exists')) {
      logger.warn(`MCF: Order ${sellerFulfillmentOrderId} exists. Handled.`);
      return { success: true, sellerFulfillmentOrderId, alreadyExists: true };
    }
    throw err;
  }
}

/**
 * GET /fba/outbound/2020-07-01/fulfillmentOrders/{id}
 */
export async function getFulfillmentOrder(sellerFulfillmentOrderId) {
  const response = await spApiRequest('GET', `${MCF_BASE}/fulfillmentOrders/${encodeURIComponent(sellerFulfillmentOrderId)}`);
  const payload = response.data?.payload;
  if (!payload) throw new Error('MCF: Invalid payload');

  const { fulfillmentOrder, fulfillmentShipments } = payload;
  
  const allTracking = (fulfillmentShipments || []).flatMap(s => 
    (s.fulfillmentShipmentPackages?.member || []).map(pkg => ({
      status: s.fulfillmentShipmentStatus,
      trackingNumber: pkg.trackingNumber || s.trackingNumber,
      carrierCode: pkg.carrierCode,
      estimatedArrival: s.estimatedArrivalDate
    }))
  );

  return {
    status: fulfillmentOrder.fulfillmentOrderStatus,
    tracking: allTracking,
    primaryTracking: allTracking[0]?.trackingNumber || null,
    primaryCarrier: allTracking[0]?.carrierCode || null
  };
}

/**
 * POST /fba/outbound/2020-07-01/fulfillmentOrders/preview
 */
export async function getFulfillmentPreview(address, items) {
  const normState = normalizeState(address.stateOrRegion || '');
  
  const payload = {
    marketplaceId: process.env.AMAZON_MARKETPLACE_ID_US || 'ATVPDKIKX0DER',
    address: {
      name: sanitizeMCFField(address.name, 50),
      addressLine1: sanitizeMCFField(address.line1, 60),
      city: sanitizeMCFField(address.city, 50),
      stateOrRegion: sanitizeMCFField(normState, 150),
      postalCode: sanitizeMCFField(address.postalCode, 15),
      countryCode: 'US',
      phone: sanitizeMCFPhone(address.phone)
    },
    items: items.map((item, idx) => ({
      sellerSku: (item.sellerSku || item.sku || '').trim(),
      quantity: item.quantity,
      sellerFulfillmentOrderItemId: `preview-${idx}`
    }))
  };

  try {
    const response = await spApiRequest('POST', `${MCF_BASE}/fulfillmentOrders/preview`, payload);
    const previews = response.data?.payload?.fulfillmentPreviews || [];
    
    return previews.map(p => {
      const totalFee = (p.estimatedFees || []).reduce((sum, fee) => sum + parseFloat(fee.amount.value || 0), 0);
      return {
        shippingSpeedCategory: p.shippingSpeedCategory,
        isFulfillable: p.isFulfillable,
        totalFee: parseFloat(totalFee.toFixed(2)),
        currency: p.estimatedFees?.[0]?.amount?.currencyCode || 'USD',
        fulfillmentPreviewShipments: p.fulfillmentPreviewShipments
      };
    });
  } catch (err) {
    logger.error(`MCF Preview Failed: ${err.message}`);
    throw err;
  }
}

/**
 * GET /fba/inventory/v1/summaries
 */
export async function listInventory(skus = []) {
  const marketplaceId = process.env.AMAZON_MARKETPLACE_ID_US || 'ATVPDKIKX0DER';
  let allSummaries = [];
  let nextToken = null;

  do {
    const qs = new URLSearchParams({ granularityType: 'Marketplace', granularityId: marketplaceId, marketplaceIds: marketplaceId, details: 'true' });
    if (nextToken) qs.append('nextToken', nextToken);

    const response = await spApiRequest('GET', `/fba/inventory/v1/summaries?${qs.toString()}`);
    allSummaries.push(...(response.data?.payload?.inventorySummaries || []));
    nextToken = response.data?.pagination?.nextToken;
  } while (nextToken);

  const mapped = allSummaries.map(s => ({ sku: s.sellerSku, quantity: s.inventoryDetails?.fulfillableQuantity || 0 }));
  if (skus.length > 0) {
    const skuSet = new Set(skus.map(s => s.trim()));
    return mapped.filter(item => skuSet.has(item.sku));
  }
  return mapped;
}

/**
 * PUT /fba/outbound/2020-07-01/fulfillmentOrders/{id}/cancel
 * Attempt to cancel an order in Amazon MCF.
 */
export async function cancelFulfillmentOrder(sellerFulfillmentOrderId) {
  try {
    await spApiRequest('PUT', `${MCF_BASE}/fulfillmentOrders/${encodeURIComponent(sellerFulfillmentOrderId)}/cancel`, {});
    return { success: true };
  } catch (err) {
    logger.error(`MCF: Failed to cancel order ${sellerFulfillmentOrderId}: ${err.message}`);
    throw err;
  }
}

export default { createFulfillmentOrder, getFulfillmentOrder, getFulfillmentPreview, listInventory, cancelFulfillmentOrder };
