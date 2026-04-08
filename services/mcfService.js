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

export async function getProductDimensionsFromMCF(sku, asin = null) {
  logger.debug(`MCF: Fetching dimensions for SKU: ${sku}, ASIN: ${asin || 'not provided'}`);

  try {
    let targetAsin = asin;

    // 1. If we don't have an ASIN, try to resolve SKU -> ASIN using Listings Items API
    if (!targetAsin) {
      try {
        const sellerId = process.env.AMAZON_SELLER_ID;
        const marketplaceId = process.env.AMAZON_MARKETPLACE_ID_US || 'ATVPDKIKX0DER';
        
        logger.debug(`MCF: Resolving SKU ${sku} to ASIN via Listings API...`);
        const listingsRes = await spApiRequest(
          'GET', 
          `/listings/2021-08-01/items/${sellerId}/${sku}`, 
          null, 
          { marketplaceIds: marketplaceId }
        );
        
        targetAsin = listingsRes.data?.summaries?.[0]?.asin;
        if (targetAsin) {
          logger.debug(`MCF: Resolved ${sku} to ASIN: ${targetAsin}`);
        }
      } catch (e) {
        logger.warn(`MCF: Failed to resolve SKU to ASIN via Listings API: ${e.message}`);
        // Fallback to trying SKU in Catalog anyway (will likely fail if Listings API failed, but worth a shot)
      }
    }

    // 2. Use Amazon Catalog API to get item details
    const catalogParams = {
      marketplaceIds: process.env.AMAZON_MARKETPLACE_ID_US || 'ATVPDKIKX0DER',
      includedData: 'attributes'
    };

    if (targetAsin) {
      catalogParams.identifiers = targetAsin;
      catalogParams.identifiersType = 'ASIN';
    } else {
      // Note: Catalog API v2022-04-01 technically does NOT support SKU type for identifiers, 
      // but we keep this as a last-ditch effort/standard pattern.
      catalogParams.identifiers = sku;
      catalogParams.identifiersType = 'SKU'; 
    }

    const response = await spApiRequest('GET', '/catalog/2022-04-01/items', null, catalogParams);
    const item = response.data?.items?.[0]; // Note: Catalog API v2022-04-01 has items at root, not payload.items

    if (!item) {
      throw new Error(`Product not found in Amazon catalog: ${targetAsin || sku}`);
    }

    // Extract package dimensions and weight
    const attributes = item.attributes || {};
    // Attributes in v2022-04-01 are often returned as arrays or objects depending on the attribute
    const pkgDim = attributes.item_package_dimensions?.[0];
    const pkgWeight = attributes.item_package_weight?.[0];

    if (!pkgDim || !pkgWeight) {
      logger.warn(`MCF: Dimensions or weight missing in catalog for ${targetAsin || sku}`);
      return { dimensions: null, weight_kg: null };
    }

    // Amazon returns inches & pounds for North America catalog items by default
    const dimUnit = pkgDim.length.unit?.toLowerCase() || 'inches';
    const weightUnit = pkgWeight.unit?.toLowerCase() || 'pounds';

    let lengthIn, widthIn, heightIn, weightLb, lengthCm, widthCm, heightCm, weightKg;

    if (dimUnit === 'inches') {
      lengthIn = pkgDim.length.value;
      widthIn = pkgDim.width.value;
      heightIn = pkgDim.height.value;
      lengthCm = lengthIn * 2.54;
      widthCm = widthIn * 2.54;
      heightCm = heightIn * 2.54;
    } else {
      lengthCm = pkgDim.length.value;
      widthCm = pkgDim.width.value;
      heightCm = pkgDim.height.value;
      lengthIn = lengthCm / 2.54;
      widthIn = widthCm / 2.54;
      heightIn = heightCm / 2.54;
    }

    if (weightUnit === 'pounds') {
      weightLb = pkgWeight.value;
      weightKg = weightLb * 0.453592;
    } else {
      weightKg = pkgWeight.value;
      weightLb = weightKg / 0.453592;
    }

    return {
      dimensions: `${lengthCm.toFixed(2)}x${widthCm.toFixed(2)}x${heightCm.toFixed(2)} cm`,
      dimensions_imperial: `${lengthIn.toFixed(2)}x${widthIn.toFixed(2)}x${heightIn.toFixed(2)} in`,
      weight_kg: Number(weightKg.toFixed(3)),
      weight_lb: Number(weightLb.toFixed(3)),
      asin: targetAsin
    };

  } catch (err) {
    const errorBody = err.response?.data || err.spApiError;
    logger.error(`MCF: Failed to get dimensions for SKU ${sku}:`, {
      message: err.message,
      amazonError: errorBody ? JSON.stringify(errorBody) : 'No detail'
    });
    throw new Error(`Unable to fetch product dimensions from Amazon: ${err.message}`);
  }
}

export async function batchFetchProductDimensions(skus) {
  logger.info(`MCF: Batch fetching dimensions for ${skus.length} SKUs`);

  const results = [];
  const errors = [];

  for (const sku of skus) {
    try {
      const dimensionData = await getProductDimensionsFromMCF(sku);
      results.push(dimensionData);

      // Rate limiting - Amazon allows ~1 request per second
      await new Promise(resolve => setTimeout(resolve, 1200));

    } catch (err) {
      logger.error(`Failed to fetch dimensions for ${sku}:`, err.message);
      errors.push({ sku, error: err.message });
    }
  }

  return { results, errors };
}

export async function getFulfillmentPreview(address, items) {

  const invalidItems = items.filter(i => !(i.sellerSku || i.sku));
  if (invalidItems.length > 0) {
    throw new Error(`MCF: Cannot get preview. One or more items are missing a Seller SKU.`);
  }

  // Check if items have dimensions in our database
  const itemsWithoutDimensions = items.filter(i => !i.dimensions || !i.weight_kg);
  if (itemsWithoutDimensions.length > 0) {
    logger.warn(`MCF: ${itemsWithoutDimensions.length} items missing dimensions. Shipping estimates may be inaccurate.`);
    logger.warn(`Missing dimensions for SKUs: ${itemsWithoutDimensions.map(i => i.sellerSku || i.sku).join(', ')}`);
    logger.warn(`MCF: Consider running: node scripts/fetch-dimensions-from-amazon.js`);
  }

  const normalizedState = normalizeState(address.stateOrRegion);
  const commonCanadianProvinces = ['ON', 'QC', 'BC', 'AB', 'MB', 'SK', 'NS', 'NB', 'NL', 'PE', 'NT', 'NU', 'YT'];

  if (commonCanadianProvinces.includes(normalizedState) && address.countryCode === 'US') {
      throw new Error(`Amazon MCF (US) does not accept Canadian provinces (${normalizedState}). Please change to a US state or select Canada as your region.`);
  }

  const payload = {
    marketplaceId: process.env.AMAZON_MARKETPLACE_ID_US || 'ATVPDKIKX0DER',
    address: {
      name:          address.name,
      addressLine1:  address.line1,
      addressLine2:  address.line2 || '',
      city:          address.city,
      stateOrRegion: normalizedState,
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

  // Process and validate shipping estimates
  const processedPreviews = previews.map((p) => {
    const fees = (p.estimatedFees || []).map((fee) => ({
      name:   fee.name,
      amount: fee.amount
    }));

    const totalFee = fees.reduce((sum, f) => sum + parseFloat(f.amount.value || 0), 0);
    const currency = fees.length > 0 ? fees[0].amount.currencyCode : 'USD';

    // Log warning for suspiciously high shipping costs
    const totalItemValue = items.reduce((sum, item) => sum + (item.price || 0) * item.quantity, 0);
    if (totalItemValue > 0) {
      const shippingRatio = totalFee / totalItemValue;
      if (shippingRatio > 0.5) { // Shipping > 50% of item value
        logger.warn(`MCF: High shipping cost detected - $${totalFee.toFixed(2)} for $${totalItemValue.toFixed(2)} items (${(shippingRatio * 100).toFixed(1)}% ratio)`);
      }
    }

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

  return processedPreviews;
}

/**
 * calculateManualEstimate — Fallback offline calculation
 * ONLY used when Amazon MCF Preview API is completely unavailable.
 */
export function calculateManualEstimate(items) {
    const totalFee = calculateMCFShipping(items);
    
    return [{
        shippingSpeedCategory: 'Standard',
        isFulfillable: true,
        totalFee,
        currency: 'USD',
        name: 'Standard Shipping',
        price: totalFee,
        estimation: 'Estimated 5-7 business days (offline estimate)'
    }];
}

/**
 * listInventory — Fetches FBA inventory from Amazon SP-API
 * 
 * IMPORTANT FIXES (March 2026):
 * 1. Handles PAGINATION (nextToken) — Amazon returns paginated results
 * 2. When skus=[] (empty), fetches ALL inventory (like view_mcf_stock.js does)
 * 3. When specific SKUs given, fetches ALL then filters locally
 *    (avoids URL length issues with SKUs containing spaces like "DIRT LOCK-SW180 BLACK")
 */
export async function listInventory(skus = []) {
  const marketplaceId = process.env.AMAZON_MARKETPLACE_ID_US || 'ATVPDKIKX0DER';
  
  // Always fetch ALL inventory (don't pass sellerSkus in URL)
  // This avoids URL encoding issues with SKUs containing spaces
  // and ensures we get complete results. We filter locally afterwards.
  const allSummaries = [];
  let nextToken = null;
  let pageCount = 0;
  const MAX_PAGES = 20; // Safety limit

  do {
    const qs = new URLSearchParams();
    qs.append('granularityType', 'Marketplace');
    qs.append('granularityId',   marketplaceId);
    qs.append('marketplaceIds',  marketplaceId);
    qs.append('details',         'true');

    if (nextToken) {
      qs.append('nextToken', nextToken);
    }

    const response = await spApiRequest('GET', `/fba/inventory/v1/summaries?${qs.toString()}`);
    const payload = response.data?.payload || {};
    const summaries = payload.inventorySummaries || [];
    
    allSummaries.push(...summaries);
    // CRITICAL: nextToken is at response.data.pagination.nextToken, NOT payload.nextToken
    nextToken = response.data?.pagination?.nextToken || null;
    pageCount++;

    if (nextToken) {
      logger.debug(`InventoryAPI: Page ${pageCount} fetched (${summaries.length} items). Fetching next page...`);
    }
  } while (nextToken && pageCount < MAX_PAGES);

  logger.info(`InventoryAPI: Fetched ${allSummaries.length} total inventory summaries across ${pageCount} page(s).`);

  // Map to simplified format
  const mapped = allSummaries.map(s => ({
    sku:      s.sellerSku,
    quantity: s.inventoryDetails?.fulfillableQuantity || 0,
    asin:     s.asin,
    fnsku:    s.fnsku
  }));

  // If specific SKUs were requested, filter to only those
  if (skus.length > 0) {
    const skuSet = new Set(skus.map(s => s.trim()));
    return mapped.filter(item => skuSet.has(item.sku));
  }

  return mapped;
}

export default {
  createFulfillmentOrder,
  getFulfillmentOrder,
  cancelFulfillmentOrder,
  getFulfillmentPreview,
  listInventory,
  getProductDimensionsFromMCF,
  calculateManualEstimate
};
