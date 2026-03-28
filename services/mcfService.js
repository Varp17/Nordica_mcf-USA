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


const MCF_BASE = '/fba/outbound/2020-07-01';

// ─────────────────────────────────────────────────────────────────────────────
//  SHIPPING SPEED MAP
//  Values accepted by Amazon MCF
// ─────────────────────────────────────────────────────────────────────────────
const SPEED_MAP = {
  standard:  'Standard',
  expedited: 'Expedited',
  priority:  'Priority',
  scheduled: 'ScheduledDelivery'
};

export async function createFulfillmentOrder(order) {
  const sellerFulfillmentOrderId = generateMCFOrderId(order.order_number);
  const shippingSpeed = SPEED_MAP[order.shipping_speed?.toLowerCase()] || 'Standard';

  // Amazon MCF strictly enforces character limits. We truncate to be safe.
  const trunc = (str, len) => (str || '').toString().substring(0, len);

  const payload = {
    marketplaceId:             process.env.AMAZON_MARKETPLACE_ID_US || 'ATVPDKIKX0DER',
    sellerFulfillmentOrderId,
    displayableOrderId:        order.order_number,
    displayableOrderDate:      new Date(order.created_at).toISOString(),
    displayableOrderComment:   trunc(`Order from ${process.env.STORE_NAME || 'Nordica Ecom'}`, 250),
    shippingSpeedCategory:     shippingSpeed,
    destinationAddress: {
      name:                trunc(`${order.shipping_first_name} ${order.shipping_last_name}`.trim(), 50),
      addressLine1:        trunc(order.shipping_address1, 60),
      addressLine2:        trunc(order.shipping_address2 || '', 60),
      city:                trunc(order.shipping_city, 50),
      stateOrRegion:       trunc(normalizeState(order.shipping_state || order.shipping_province), 150),
      postalCode:          trunc(order.shipping_zip || order.shipping_postal_code, 20),
      countryCode:         'US',
      phone:               trunc(order.shipping_phone || '', 20)
    },
    items: (order.items || []).map((item, idx) => ({
      sellerSku:                      item.sku,
      sellerFulfillmentOrderItemId:   `${sellerFulfillmentOrderId}-${idx + 1}`,
      quantity:                       item.quantity,
      displayableComment:             trunc(item.product_name, 250),
      perUnitDeclaredValue: {
        currencyCode: 'USD',
        value:        String(parseFloat(item.unit_price || 0).toFixed(2))
      }
    })),
    notificationEmails: [order.customer_email].filter(Boolean),
    featureConstraints: []
  };

  logger.info(`MCF: Creating fulfillment order`, {
    sellerFulfillmentOrderId,
    orderId:   order.id,
    itemCount: (order.items || []).length,
    speed:     shippingSpeed
  });

  try {
    await spApiRequest('POST', `${MCF_BASE}/fulfillmentOrders`, payload);
    logger.info(`MCF: Fulfillment order created — ${sellerFulfillmentOrderId}`);
    return { success: true, sellerFulfillmentOrderId };
  } catch (err) {
    const errorData = err.response?.data?.errors?.[0];
    if (err.response?.status === 400 && errorData?.code === 'InvalidInput' && errorData?.message?.includes('already exists')) {
      logger.warn(`MCF: Fulfillment order ${sellerFulfillmentOrderId} already exists in Amazon — treating as success.`);
      return { success: true, sellerFulfillmentOrderId, alreadyExists: true };
    }
    throw err;
  }
}

export async function getFulfillmentOrder(sellerFulfillmentOrderId) {
  const response = await spApiRequest(
    'GET',
    `${MCF_BASE}/fulfillmentOrders/${encodeURIComponent(sellerFulfillmentOrderId)}`
  );

  const payload = response.data?.payload;
  if (!payload) throw new Error('MCF: Empty payload in getFulfillmentOrder response');

  const { fulfillmentOrder, fulfillmentShipments } = payload;

  const allTracking = (fulfillmentShipments || []).flatMap((shipment) => {
    return (shipment.fulfillmentShipmentPackages?.member || []).map((pkg) => ({
      amazonShipmentReference: shipment.amazonShipmentReference,
      fulfillmentShipmentStatus: shipment.fulfillmentShipmentStatus,
      shippingService: shipment.shippingService || '',
      trackingNumber: pkg.trackingNumber || shipment.trackingNumber,
      carrierCode: pkg.carrierCode,
      estimatedArrivalDate: shipment.estimatedArrivalDate || null
    }));
  });

  return {
    status:              fulfillmentOrder.fulfillmentOrderStatus,
    statusLastUpdated:   fulfillmentOrder.statusUpdatedDate,
    destinationAddress:  fulfillmentOrder.destinationAddress,
    shippingSpeedCategory: fulfillmentOrder.shippingSpeedCategory,
    tracking:            allTracking,
    primaryTrackingNumber: allTracking.length > 0 ? allTracking[0].trackingNumber : null,
    primaryCarrier:        allTracking.length > 0 ? allTracking[0].carrierCode || allTracking[0].shippingService : null,
    estimatedDelivery:     allTracking.length > 0 ? allTracking[0].estimatedArrivalDate : null
  };
}

export async function cancelFulfillmentOrder(sellerFulfillmentOrderId) {
  logger.info(`MCF: Cancelling fulfillment order ${sellerFulfillmentOrderId}`);
  await spApiRequest(
    'PUT',
    `${MCF_BASE}/fulfillmentOrders/${encodeURIComponent(sellerFulfillmentOrderId)}/cancel`
  );
  logger.info(`MCF: Order ${sellerFulfillmentOrderId} cancellation submitted`);
  return { success: true };
}

export async function getFulfillmentPreview(address, items) {
  logger.debug(`MCF: Preview request for items: ${JSON.stringify(items.map(i => i.sellerSku || i.sku))} to ${address.stateOrRegion}, ${address.postalCode}`);
  
  const invalidItems = items.filter(i => !(i.sellerSku || i.sku));
  if (invalidItems.length > 0) {
    throw new Error(`MCF: Cannot get preview. One or more items are missing a Seller SKU.`);
  }

  const payload = {
    marketplaceId: process.env.AMAZON_MARKETPLACE_ID_US || 'ATVPDKIKX0DER',
    address: {
      name:          address.name,
      addressLine1:  address.line1,
      addressLine2:  address.line2 || '',
      city:          address.city,
      stateOrRegion: normalizeState(address.stateOrRegion),
      postalCode:    address.postalCode,
      countryCode:   'US',
      phone:         address.phone || ''
    },
    items: items.map((item, idx) => ({
      sellerSku: item.sellerSku || item.sku,
      quantity: item.quantity,
      sellerFulfillmentOrderItemId: `preview-item-${idx + 1}`
    })),
    includeCODFulfillmentPreview:     false,
    includeDeliveryWindows:           true,
    featureConstraints: []
  };

  logger.debug(`MCF: PREVIEW PAYLOAD: ${JSON.stringify(payload)}`);

  let previews;
  try {
    const response = await spApiRequest('POST', `${MCF_BASE}/fulfillmentOrders/preview`, payload);
    previews = response.data?.payload?.fulfillmentPreviews || [];
  } catch (err) {
    const apiErrors = err.response?.data?.errors || err.spApiError?.errors;
    const errorDetail = apiErrors && apiErrors.length > 0 ? apiErrors[0].message : (err.message || 'Unknown SP-API Error');
    
    logger.error('MCF: Preview request failed', {
      message: err.message,
      status: err.response?.status || err.spApiStatus,
      apiErrors,
      stack: err.stack
    });

    throw new Error(`Amazon MCF Error: ${errorDetail}`);
  }

  return previews.map((p) => {
    const fees = (p.estimatedFees || []).map((fee) => ({
      name:   fee.name,
      amount: fee.amount
    }));

    const totalFee = fees.reduce((sum, f) => sum + parseFloat(f.amount.value || 0), 0);
    const currency = fees.length > 0 ? fees[0].amount.currencyCode : 'USD';

    return {
      shippingSpeedCategory: p.shippingSpeedCategory,
      isFulfillable:         p.isFulfillable,
      scheduledDeliveryInfo: p.scheduledDeliveryInfo || null,
      estimatedShippingWeight: p.estimatedShippingWeight || null,
      totalFee,
      currency,
      estimatedFees: fees,
      fulfillmentPreviewShipments: (p.fulfillmentPreviewShipments || []).map((s) => ({
        earliestShipDate:   s.earliestShipDate,
        latestShipDate:     s.latestShipDate,
        earliestArrival:    s.earliestArrivalDate,
        latestArrival:      s.latestArrivalDate
      }))
    };
  });
}

export async function listInventory(skus = []) {
  const marketplaceId = process.env.AMAZON_MARKETPLACE_ID_US || 'ATVPDKIKX0DER';
  const qs = new URLSearchParams();
  qs.append('granularityType', 'Marketplace');
  qs.append('granularityId',   marketplaceId);
  qs.append('marketplaceIds',  marketplaceId);
  qs.append('details',         'true');

  if (skus.length) {
    skus.forEach(sku => qs.append('sellerSkus', sku));
  }

  const response = await spApiRequest('GET', `/fba/inventory/v1/summaries?${qs.toString()}`);
  const summaries = response.data?.payload?.inventorySummaries || [];

  return summaries.map(s => ({
    sku:      s.sellerSku,
    quantity: s.inventoryDetails?.fulfillableQuantity || 0,
    asin:     s.asin,
    fnsku:    s.fnsku
  }));
}

export default {
  createFulfillmentOrder,
  getFulfillmentOrder,
  cancelFulfillmentOrder,
  getFulfillmentPreview,
  listInventory
};
