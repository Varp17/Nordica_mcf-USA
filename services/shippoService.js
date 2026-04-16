'use strict';

/**
 * Shippo Service — Canada Fulfillment
 */

import 'dotenv/config';
import { Shippo } from 'shippo';
import axios from 'axios';
import logger from '../utils/logger.js';
import { retryWithBackoff } from '../utils/helpers.js';

let _shippo = null;

export function getShippo() {
  if (!_shippo) {
    const apiKey = process.env.SHIPPO_API_TOKEN || process.env.SHIPPO_API_KEY;
    _shippo = new Shippo({ apiKeyHeader: apiKey });
  }
  return _shippo;
}

function getAuthHeaders() {
  const apiKey = process.env.SHIPPO_API_TOKEN || process.env.SHIPPO_API_KEY;
  return {
    'Authorization': `ShippoToken ${apiKey}`,
    'SHIPPO-API-VERSION': '2018-02-08'
  };
}

function getWarehouseAddress() {
  return {
    name:    process.env.SHIPPO_FROM_NAME    || 'Nordica Ecom Warehouse',
    street1: process.env.SHIPPO_FROM_STREET1 || '123 Warehouse St',
    city:    process.env.SHIPPO_FROM_CITY    || 'Toronto',
    state:   process.env.SHIPPO_FROM_STATE   || 'ON',
    zip:     process.env.SHIPPO_FROM_ZIP     || 'M5H2N2',
    country: process.env.SHIPPO_FROM_COUNTRY || 'CA',
    phone:   process.env.SHIPPO_FROM_PHONE   || '',
    email:   process.env.SHIPPO_FROM_EMAIL   || ''
  };
}

/**
 * Validate customer address
 */
export async function validateAddress(addressData) {
  const headers = getAuthHeaders();
  const country = (addressData.country || 'CA').toUpperCase();
  const postalCode = (addressData.postalCode || addressData.zip || '').replace(/\s+/g, '').toUpperCase();

  if (country === 'CA') {
    const caPostalRegex = /^[A-Z]\d[A-Z]\d[A-Z]\d$/;
    if (!caPostalRegex.test(postalCode)) {
      return {
        valid: false,
        fieldErrors: { zip: 'Invalid Canadian postal code format (A1A1A1)' }
      };
    }
    return {
      valid: true,
      correctedAddress: { ...addressData, zip: postalCode }
    };
  }

  try {
    const response = await axios.post('https://api.goshippo.com/addresses/', {
      name:    `${addressData.firstName} ${addressData.lastName}`.trim(),
      street1: addressData.address1,
      city:    addressData.city,
      state:   addressData.province || addressData.state,
      zip:     postalCode,
      country: country,
      validate: true
    }, { headers, timeout: 10000 });

    const addr = response.data;
    const isValid = addr.validation_results?.is_valid === true;
    return {
      valid: isValid,
      fieldErrors: isValid ? {} : { general: 'Address validation failed' },
      addressId: addr.object_id
    };
  } catch (err) {
    logger.error(`Shippo Validation Error: ${err.message}`);
    return { valid: true }; // Fallback
  }
}

/**
 * Generate Shipping Rates
 */
export async function getShippingRates(order) {
  const headers = getAuthHeaders();
  const fromAddr = getWarehouseAddress();
  const { totalLength, totalWidth, totalHeight, totalWeight } = _calculatePackageDimensions(order.items || []);

  const [addressFrom, addressTo, parcel] = await Promise.all([
    axios.post('https://api.goshippo.com/addresses/', fromAddr, { headers }).then(r => r.data),
    axios.post('https://api.goshippo.com/addresses/', {
      name:    `${order.shipping_first_name} ${order.shipping_last_name}`.trim(),
      street1: order.shipping_address1,
      city:    order.shipping_city,
      state:   order.shipping_province || order.shipping_state,
      zip:     (order.shipping_postal_code || order.shipping_zip || '').replace(/\s+/g, '').toUpperCase(),
      country: 'CA'
    }, { headers }).then(r => r.data),
    axios.post('https://api.goshippo.com/parcels/', {
      length: totalLength, width: totalWidth, height: totalHeight, distance_unit: 'cm',
      weight: totalWeight, mass_unit: 'kg'
    }, { headers }).then(r => r.data)
  ]);

  const shipment = await axios.post('https://api.goshippo.com/shipments/', {
    address_from: addressFrom.object_id, address_to: addressTo.object_id,
    parcels: [parcel.object_id], async: false
  }, { headers }).then(r => r.data);

  return (shipment.rates || [])
    .filter(r => !(r.messages || []).some(m => m.type === 'error'))
    .sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))
    .map(r => ({
      rateId: r.object_id, provider: r.provider, serviceName: r.servicelevel?.name || r.provider,
      amount: parseFloat(r.amount), currency: r.currency, estimatedDays: r.estimated_days
    }));
}

/**
 * Purchase Label and Create Shipment
 */
export async function createShipment(order) {
  const headers = getAuthHeaders();
  const fromAddr = getWarehouseAddress();
  const { totalLength, totalWidth, totalHeight, totalWeight } = _calculatePackageDimensions(order.items || []);

  const [addressFrom, addressTo, parcel] = await Promise.all([
    axios.post('https://api.goshippo.com/addresses/', fromAddr, { headers }).then(r => r.data),
    axios.post('https://api.goshippo.com/addresses/', {
      name:    `${order.shipping_first_name} ${order.shipping_last_name}`.trim(),
      street1: order.shipping_address1,
      city:    order.shipping_city,
      state:   order.shipping_province || order.shipping_state,
      zip:     (order.shipping_postal_code || order.shipping_zip || '').replace(/\s+/g, '').toUpperCase(),
      country: 'CA',
      phone:   order.shipping_phone || '',
      email:   order.customer_email || order.cust_email || ''
    }, { headers }).then(r => r.data),
    axios.post('https://api.goshippo.com/parcels/', {
      length: totalLength, width: totalWidth, height: totalHeight, distance_unit: 'cm',
      weight: totalWeight, mass_unit: 'kg'
    }, { headers }).then(r => r.data)
  ]);

  const shipment = await axios.post('https://api.goshippo.com/shipments/', {
    address_from: addressFrom.object_id, address_to: addressTo.object_id,
    parcels: [parcel.object_id], async: false,
    metadata: JSON.stringify({ order_number: order.order_number })
  }, { headers }).then(r => r.data);

  if (!shipment.rates?.length) throw new Error('Shippo: No rates available');

  const preferredCarrier = process.env.SHIPPO_PREFERRED_CARRIER || 'Canada Post';
  let selectedRate = shipment.rates.find(r => r.provider.toLowerCase().includes(preferredCarrier.toLowerCase()));
  if (!selectedRate) selectedRate = shipment.rates.sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))[0];

  const transaction = await retryWithBackoff(async () => {
    const res = await axios.post('https://api.goshippo.com/transactions/', {
      rate: selectedRate.object_id, label_file_type: 'PDF', async: false
    }, { headers, timeout: 30000 });
    if (res.data.status !== 'SUCCESS') throw new Error(`Shippo: ${res.data.messages?.[0]?.text || 'Purchase failed'}`);
    return res.data;
  }, 2, 1000);

  return {
    shippoTransactionId: transaction.object_id,
    trackingNumber: transaction.tracking_number,
    trackingUrl: transaction.tracking_url_provider,
    labelUrl: transaction.label_url,
    carrier: selectedRate.provider,
    serviceName: selectedRate.servicelevel?.name || selectedRate.provider,
    actualCost: parseFloat(selectedRate.amount || 0)
  };
}

export async function registerTracking(carrier, trackingNumber) {
  const headers = getAuthHeaders();
  return retryWithBackoff(async () => {
    await axios.post('https://api.goshippo.com/tracks/', { carrier, tracking_number: trackingNumber }, { headers });
  });
}

/**
 * Fetch current tracking status from Shippo
 */
export async function getTrackingStatus(carrier, trackingNumber) {
  const headers = getAuthHeaders();
  const res = await axios.get(`https://api.goshippo.com/tracks/${carrier}/${trackingNumber}/`, { headers });
  return res.data;
}

/**
 * Refund a label (for cancellations)
 */
export async function refundLabel(transactionId) {
  const headers = getAuthHeaders();
  const res = await axios.post('https://api.goshippo.com/refunds/', { transaction: transactionId }, { headers });
  return res.data;
}

/**
 * ── Dimension Calculation ─────────────────────────────────────────────────────
 */
function _calculatePackageDimensions(items) {
  if (!items?.length) return { totalLength: 20, totalWidth: 15, totalHeight: 10, totalWeight: 0.5 };

  let maxLength = 20, maxWidth = 15, totalHeight = 0, totalWeight = 0;

  for (const item of items) {
    const qty = Math.max(1, parseInt(item.quantity) || 1);
    const weight = Math.max(0.1, parseFloat(item.weight_kg || item.weightKg || 0.5));
    totalWeight += weight * qty;

    let l = 20, w = 15, h = 10;
    const dimStr = String(item.dimensions || '20x15x10');
    const parts = dimStr.split('x').map(p => parseFloat(p) || 0);
    if (parts.length >= 3) { [l, w, h] = parts; }

    maxLength = Math.max(maxLength, l);
    maxWidth = Math.max(maxWidth, w);
    totalHeight += (h || 10) * qty;
  }

  return {
    totalLength: Math.max(15, parseFloat((maxLength + 2).toFixed(2))),
    totalWidth: Math.max(10, parseFloat((maxWidth + 2).toFixed(2))),
    totalHeight: Math.max(5, parseFloat((totalHeight + 2).toFixed(2))),
    totalWeight: Math.max(0.1, parseFloat(totalWeight.toFixed(3)))
  };
}

const shippoService = {
  getShippo,
  validateAddress,
  getShippingRates,
  createShipment,
  registerTracking,
  getTrackingStatus,
  refundLabel
};

export default shippoService;
