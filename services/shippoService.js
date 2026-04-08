'use strict';

/**
 * Shippo Service — Canada Fulfillment
 * ─────────────────────────────────────
 * Handles the full Shippo workflow for Canadian orders:
 *   1. Validate destination address
 *   2. Create shipment + fetch live rates
 *   3. Purchase label (preferred carrier → cheapest fallback)
 *   4. Return tracking number, tracking URL, and label PDF URL
 *   5. Register tracking webhook
 *   6. Retrieve live tracking status
 */

// const { Shippo } = require('shippo');
// const logger  = require('../utils/logger');
// const { retryWithBackoff } = require('../utils/helpers');

import 'dotenv/config';
import { Shippo } from 'shippo';
import axios from 'axios';
import logger from '../utils/logger.js';
import { retryWithBackoff } from '../utils/helpers.js';


// Initialize Shippo client (lazy — avoids crash if key not set in dev)
let _shippo = null;
export function getShippo() {
  if (!_shippo) {
    const apiKey = process.env.SHIPPO_API_TOKEN || process.env.SHIPPO_API_KEY;
    if (!apiKey) {
      logger.warn('Shippo API Key/Token not found in environment variables (SHIPPO_API_TOKEN or SHIPPO_API_KEY)');
    }
    // Shippo SDK v2.x requires { apiKeyHeader } and 'new'
    _shippo = new Shippo({ apiKeyHeader: apiKey });
  }
  return _shippo;
}

// ── From-address (your warehouse) ─────────────────────────────────────────────
function getAuthHeaders() {
  const apiKey = process.env.SHIPPO_API_TOKEN || process.env.SHIPPO_API_KEY;
  if (!apiKey) {
    logger.error('Shippo API Key/Token not found in process.env');
  }
  return {
    'Authorization': `ShippoToken ${apiKey}`,
    'SHIPPO-API-VERSION': '2018-02-08'
  };
}

function getWarehouseAddress() {
  return {
    name:    process.env.SHIPPO_FROM_NAME    || 'Your Store',
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
 * Validate a customer address before checkout.
 *
 * PRODUCTION STRATEGY:
 * - For Canada (CA): Shippo's database lacks street-level data for many rural/smaller
 *   communities. We validate only the postal code format locally (which is the key routing
 *   data Canada Post uses). Rates and labels work fine even with partial street matches.
 *   Only hard errors (invalid postal code format) block the checkout.
 * - For USA: Full Shippo validation is applied as usual.
 */
export async function validateAddress(addressData) {
  const headers = getAuthHeaders();
  const country = (addressData.country || 'CA').toUpperCase();
  const postalCode = (addressData.postalCode || addressData.zip || '').replace(/\s+/g, '').toUpperCase();

  // ── Canada: local postal code check only ──────────────────────────────────
  if (country === 'CA') {
    const caPostalRegex = /^[A-Z]\d[A-Z]\d[A-Z]\d$/;
    if (!caPostalRegex.test(postalCode)) {
      return {
        valid: false,
        messages: [{ type: 'address_error', text: 'Invalid Canadian postal code format. Expected format: A1A1A1 or A1A 1A1.' }],
        fieldErrors: { zip: 'Invalid postal code. Expected format: A1A 1A1' },
        correctedAddress: null
      };
    }

    // Postal code is valid — skip Shippo pre-validation for Canada.
    // Shippo resolves addresses correctly when fetching rates/creating labels.
    logger.info(`CA address pre-validation passed (postal code check only): ${postalCode}`);
    return {
      valid: true,
      messages: [],
      fieldErrors: {},
      correctedAddress: {
        city:    addressData.city,
        state:   addressData.province || addressData.state,
        zip:     postalCode,
        country: 'CA',
        line1:   addressData.address1,
        line2:   addressData.address2 || ''
      }
    };
  }

  // ── USA: full Shippo validation ────────────────────────────────────────────
  try {
    const response = await axios.post('https://api.goshippo.com/addresses/', {
      name:    `${addressData.firstName} ${addressData.lastName}`.trim(),
      street1: addressData.address1,
      street2: addressData.address2 || '',
      city:    addressData.city,
      state:   addressData.province || addressData.state,
      zip:     postalCode,
      country: country,
      phone:   addressData.phone   || '',
      email:   addressData.email   || '',
      validate: true
    }, { headers });

    const address = response.data;
    const messages = address.validation_results?.messages || [];
    const fieldErrors = {};

    messages.forEach(m => {
      if (m.type === 'address_error') {
        const text = m.text.toLowerCase();
        if (text.includes('postal_code') || text.includes('zip') || m.code === 'postal_code_not_found') {
          fieldErrors.zip = m.text;
        } else if (text.includes('street') || text.includes('address')) {
          fieldErrors.street = m.text;
        } else if (text.includes('city')) {
          fieldErrors.city = m.text;
        } else if (text.includes('state') || text.includes('province')) {
          fieldErrors.state = m.text;
        } else if (text.includes('country')) {
          fieldErrors.country = m.text;
        } else {
          fieldErrors.general = fieldErrors.general ? `${fieldErrors.general}; ${m.text}` : m.text;
        }
      }
    });

    const isValid = address.validation_results?.is_valid === true ||
                   (address.object_state === 'VALID' && Object.keys(fieldErrors).length === 0);

    return {
      valid: !!isValid,
      messages,
      fieldErrors,
      addressId: address.object_id,
      correctedAddress: {
        city:    address.city,
        state:   address.state,
        zip:     address.zip,
        country: address.country,
        line1:   address.street1,
        line2:   address.street2
      }
    };
  } catch (err) {
    logger.error(`Shippo Address Validation Error: ${err.response?.data?.detail || err.message}`);
    // On validation API error, pass through — don't block checkout
    return {
      valid: true,
      messages: [],
      fieldErrors: {},
      correctedAddress: null
    };
  }
}

export async function getShippingRates(order) {
  const headers = getAuthHeaders();
  const fromAddr = getWarehouseAddress();
  const { totalLength, totalWidth, totalHeight, totalWeight } = _calculatePackageDimensions(order.items || []);

  const [addressFrom, addressTo, parcel] = await Promise.all([
    axios.post('https://api.goshippo.com/addresses/', fromAddr, { headers }).then(r => r.data),
    axios.post('https://api.goshippo.com/addresses/', {
      name:    `${order.shipping_first_name} ${order.shipping_last_name}`.trim(),
      street1: order.shipping_address1,
      street2: order.shipping_address2 || '',
      city:    order.shipping_city,
      state:   order.shipping_province || order.shipping_state,
      zip:     (order.shipping_postal_code || order.shipping_zip || '').replace(/\s+/g, '').toUpperCase(),
      country: 'CA',
      phone:   order.shipping_phone || ''
    }, { headers }).then(r => r.data),
    axios.post('https://api.goshippo.com/parcels/', {
      length:        totalLength.toString(),
      width:         totalWidth.toString(),
      height:        totalHeight.toString(),
      distance_unit:  'cm',
      weight:        totalWeight.toFixed(3),
      mass_unit:      'kg'
    }, { headers }).then(r => r.data)
  ]);

  const shipmentResponse = await axios.post('https://api.goshippo.com/shipments/', {
    address_from:  addressFrom.object_id,
    address_to:    addressTo.object_id,
    parcels:      [parcel.object_id],
    async:        false
  }, { headers });

  const shipment = shipmentResponse.data;

  if (!shipment.rates || shipment.rates.length === 0) {
    throw new Error('Shippo: No rates returned for this shipment');
  }

  const validRates = shipment.rates.filter(r => 
    r.object_id && 
    !(r.messages || []).some(m => m.type === 'error')
  );

  return validRates
    .sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))
    .map(r => ({
      rateId:           r.object_id,
      provider:         r.provider,
      serviceName:      r.servicelevel?.name || r.provider,
      serviceToken:     r.servicelevel?.token,
      currency:         r.currency,
      amount:           parseFloat(r.amount),
      estimatedDays:    r.estimated_days,
      durationTerms:    r.duration_terms || null
    }));
}

export async function createShipment(order) {
  const headers = getAuthHeaders();
  const fromAddr = getWarehouseAddress();

  logger.info(`Shippo: Creating shipment for order ${order.order_number}`);

  const [addressFrom, addressTo] = await Promise.all([
    axios.post('https://api.goshippo.com/addresses/', fromAddr, { headers }).then(r => r.data),
    axios.post('https://api.goshippo.com/addresses/', {
      name:    `${order.shipping_first_name} ${order.shipping_last_name}`.trim(),
      company: order.shipping_company || '',
      street1: order.shipping_address1,
      street2: order.shipping_address2 || '',
      city:    order.shipping_city,
      state:   order.shipping_province || order.shipping_state,
      zip:     (order.shipping_postal_code || order.shipping_zip || '').replace(/\s+/g, '').toUpperCase(),
      country: 'CA',
      phone:   order.shipping_phone || '',
      email:   order.customer_email || ''
    }, { headers }).then(r => r.data)
  ]);

  const totalWeightKg = _totalWeightKg(order.items || []);
  const { totalLength, totalWidth, totalHeight } = _calculatePackageDimensions(order.items || []);
  
  const parcel = await axios.post('https://api.goshippo.com/parcels/', {
    length:        totalLength.toString(),
    width:         totalWidth.toString(),
    height:        totalHeight.toString(),
    distance_unit:  'cm',
    weight:        totalWeightKg.toFixed(3),
    mass_unit:      'kg'
  }, { headers }).then(r => r.data);

  const shipmentResponse = await axios.post('https://api.goshippo.com/shipments/', {
    address_from:    addressFrom.object_id,
    address_to:      addressTo.object_id,
    parcels:        [parcel.object_id],
    async:          false,
    metadata:       `Order ${order.order_number}`
  }, { headers });

  const shipment = shipmentResponse.data;

  if (!shipment.rates || shipment.rates.length === 0) {
    throw new Error(`Shippo: No rates returned for order ${order.order_number}`);
  }

  const preSelectedRateId = order.shipping_speed?.startsWith('rate_') ? order.shipping_speed : null;
  
  let selectedRate = null;
  if (preSelectedRateId) {
    selectedRate = shipment.rates.find(r => r.object_id === preSelectedRateId);
    if (selectedRate) {
      logger.info(`Shippo: Using pre-selected rate ${preSelectedRateId} (${selectedRate.servicelevel?.name})`);
    } else {
      logger.warn(`Shippo: Pre-selected rate ${preSelectedRateId} not found in current shipment. Falling back to default.`);
    }
  }

  if (!selectedRate) {
    const preferredCarrier = process.env.SHIPPO_PREFERRED_CARRIER || 'Canada Post';
    const validRates = shipment.rates.filter(r => 
      r.object_id && 
      !(r.messages || []).some(m => m.type === 'error')
    );

    selectedRate =
      validRates.find(r => r.provider.toLowerCase().includes(preferredCarrier.toLowerCase())) ||
      validRates.sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))[0];
  }

  if (!selectedRate) {
    throw new Error(`Shippo: No valid rate found for order ${order.order_number}`);
  }

  const transaction = await retryWithBackoff(async () => {
    // BYPASS SDK: Use axios to avoid "Response validation failed" in SDK v2
    const response = await axios.post('https://api.goshippo.com/transactions/', {
      rate:            selectedRate.object_id,
      label_file_type: 'PDF',
      async:           false
    }, { headers });

    const txn = response.data;

    if (txn.status !== 'SUCCESS' && txn.status !== 'QUEUED') {
      const msgs = (txn.messages || []).map(m => m.text).join('; ');
      throw new Error(`Shippo label purchase failed: ${msgs}`);
    }

    return txn;
  }, 2, 1000);

  return {
    transactionId:    transaction.object_id,
    trackingNumber:   transaction.tracking_number,
    trackingUrl:      transaction.tracking_url_provider,
    labelUrl:         transaction.label_url,
    carrier:          selectedRate.provider,
    serviceName:      selectedRate.servicelevel?.name || selectedRate.provider,
    rateAmount:       parseFloat(selectedRate.amount),
    currency:         selectedRate.currency
  };
}

export async function getTrackingStatus(carrier, trackingNumber) {
  const headers = getAuthHeaders();
  
  return retryWithBackoff(async () => {
    // BYPASS SDK: Use axios to avoid validation errors
    const response = await axios.get(`https://api.goshippo.com/tracks/${carrier}/${trackingNumber}/`, { headers });
    return response.data;
  });
}

/**
 * Refund (Cancel) a purchased label
 * @param {string} transactionId - The objectId of the purchased transaction
 */
export async function refundLabel(transactionId) {
  logger.info(`Shippo: Requesting refund for transaction ${transactionId}`);
  const headers = getAuthHeaders();
  
  return retryWithBackoff(async () => {
    // BYPASS SDK: Use axios to avoid validation errors
    const response = await axios.post('https://api.goshippo.com/refunds/', { 
      transaction: transactionId,
      async: false 
    }, { headers });
    
    const refund = response.data;
    
    if (refund.status === 'ERROR') {
      const msgs = (refund.messages || []).map(m => m.text).join('; ');
      throw new Error(`Shippo refund request failed: ${msgs}`);
    }
    
    return refund;
  });
}

function _totalWeightKg(items) {
  return (items || []).reduce((sum, item) => sum + (parseFloat(item.weightKg || item.weight_kg || 0.5) * (item.quantity || 1)), 0);
}

function _calculatePackageDimensions(items) {
  if (!items || items.length === 0) {
    return { totalLength: 30, totalWidth: 20, totalHeight: 15, totalWeight: 0.5 };
  }

  let maxLength = 0, maxWidth = 0, totalHeight = 0, totalWeight = 0;

  for (const item of items) {
    const qty = item.quantity || 1;
    const weight = parseFloat(item.weightKg || item.weight_kg || 0.5);
    totalWeight += weight * qty;

    // Parse dimensions (expected format: "LxWxH" in cm)
    let length = 20, width = 15, height = 10; // defaults
    if (item.dimensions) {
      const dims = item.dimensions.split('x').map(d => parseFloat(d.trim()) || 0);
      if (dims.length >= 3) {
        [length, width, height] = dims;
      }
    }

    // For multiple items, stack them or arrange efficiently
    maxLength = Math.max(maxLength, length);
    maxWidth = Math.max(maxWidth, width);
    totalHeight += height * qty; // Stack vertically
  }

  // Add padding for packaging
  const padding = 5; // cm
  return {
    totalLength: Math.max(20, maxLength + padding),
    totalWidth: Math.max(15, maxWidth + padding),
    totalHeight: Math.max(10, totalHeight + padding),
    totalWeight: totalWeight
  };
}

function _totalLength(items) {
  const totalQty = (items || []).reduce((sum, item) => sum + (item.quantity || 1), 0);
  return Math.min(60, 20 + (totalQty * 2));
}

export default {
  validateAddress,
  getShippingRates,
  createShipment,
  getTrackingStatus,
  refundLabel
};
