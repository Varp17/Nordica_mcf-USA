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

import { Shippo } from 'shippo';
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

export async function validateAddress(addressData) {
  const shippo = getShippo();
  const country = addressData.country || 'CA';

  try {
    const address = await retryWithBackoff(async () =>
      shippo.addresses.create({
        name:    `${addressData.firstName} ${addressData.lastName}`.trim(),
        street1: addressData.address1,
        street2: addressData.address2 || '',
        city:    addressData.city,
        state:   addressData.province || addressData.state,
        zip:     (addressData.postalCode || addressData.zip || '').replace(/\s+/g, '').toUpperCase(),
        country: country,
        phone:   addressData.phone   || '',
        email:   addressData.email   || '',
        validate: true
      })
    );

    const messages = address.validationResults?.messages || [];
    const fieldErrors = {};

    // Shippo error codes to field mapping
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

    const isValid = address.validationResults?.isValid === true || (address.objectState === 'VALID' && Object.keys(fieldErrors).length === 0);

    return { 
      valid: !!isValid, 
      messages, 
      fieldErrors,
      addressId: address.objectId || address.id 
    };
  } catch (err) {
    logger.error(`Shippo Address Validation Error: ${err.message}`);
    return { valid: false, messages: [{ type: 'error', text: err.message }], fieldErrors: { general: err.message } };
  }
}

export async function getShippingRates(order) {
  const shippo    = getShippo();
  const fromAddr  = getWarehouseAddress();

  const [addressFrom, addressTo, parcel] = await Promise.all([
    retryWithBackoff(() => shippo.addresses.create(fromAddr)),
    retryWithBackoff(() => shippo.addresses.create({
      name:    `${order.shipping_first_name} ${order.shipping_last_name}`.trim(),
      street1: order.shipping_address1,
      street2: order.shipping_address2 || '',
      city:    order.shipping_city,
      state:   order.shipping_province,
      zip:     (order.shipping_postal_code || '').replace(/\s+/g, '').toUpperCase(),
      country: 'CA',
      phone:   order.shipping_phone || ''
    })),
    retryWithBackoff(() => shippo.parcels.create({
      length:        _totalLength(order.items || []).toString(),
      width:         '20',
      height:        '15',
      distanceUnit:  'cm',
      weight:        _totalWeightKg(order.items || []).toString(),
      massUnit:      'kg'
    }))
  ]);

  const shipment = await retryWithBackoff(() =>
    shippo.shipments.create({
      addressFrom:  addressFrom.objectId,
      addressTo:    addressTo.objectId,
      parcels:      [parcel.objectId],
      async:        false
    })
  );

  if (!shipment.rates || shipment.rates.length === 0) {
    throw new Error('Shippo: No rates returned for this shipment');
  }

  return shipment.rates
    .filter(r => r.objectStatus === 'VALID' || r.objectState === 'VALID')
    .sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))
    .map(r => ({
      rateId:           r.objectId,
      provider:         r.provider,
      serviceName:      r.servicelevel?.name || r.provider,
      serviceToken:     r.servicelevel?.token,
      currency:         r.currency,
      amount:           parseFloat(r.amount),
      estimatedDays:    r.estimatedDays,
      durationTerms:    r.durationTerms || null
    }));
}

export async function createShipment(order) {
  const shippo   = getShippo();
  const fromAddr = getWarehouseAddress();

  logger.info(`Shippo: Creating shipment for order ${order.order_number}`);

  const [addressFrom, addressTo] = await Promise.all([
    retryWithBackoff(() => shippo.addresses.create(fromAddr)),
    retryWithBackoff(() => shippo.addresses.create({
      name:    `${order.shipping_first_name} ${order.shipping_last_name}`.trim(),
      company: order.shipping_company || '',
      street1: order.shipping_address1,
      street2: order.shipping_address2 || '',
      city:    order.shipping_city,
      state:   order.shipping_province,
      zip:     (order.shipping_postal_code || '').replace(/\s+/g, '').toUpperCase(),
      country: 'CA',
      phone:   order.shipping_phone || '',
      email:   order.customer_email || ''
    }))
  ]);

  const totalWeightKg = _totalWeightKg(order.items || []);
  const parcel = await retryWithBackoff(() =>
    shippo.parcels.create({
      length:        '30',
      width:         '20',
      height:        '15',
      distanceUnit:  'cm',
      weight:        totalWeightKg.toFixed(3),
      massUnit:      'kg'
    })
  );

  const shipment = await retryWithBackoff(() =>
    shippo.shipments.create({
      addressFrom:    addressFrom.objectId,
      addressTo:      addressTo.objectId,
      parcels:        [parcel.objectId],
      async:          false,
      metadata:       `Order ${order.order_number}`
    })
  );

  if (!shipment.rates || shipment.rates.length === 0) {
    throw new Error(`Shippo: No rates returned for order ${order.order_number}`);
  }

  const preferredCarrier = process.env.SHIPPO_PREFERRED_CARRIER || 'Canada Post';
  const validRates       = shipment.rates.filter(r => r.objectStatus === 'VALID' || r.objectState === 'VALID');

  const selectedRate =
    validRates.find(r => r.provider.toLowerCase().includes(preferredCarrier.toLowerCase())) ||
    validRates.sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))[0];

  if (!selectedRate) {
    throw new Error(`Shippo: No valid rate found for order ${order.order_number}`);
  }

  const transaction = await retryWithBackoff(async () => {
    const txn = await shippo.transactions.create({
      rate:            selectedRate.objectId,
      labelFileType:   'PDF',
      async:           false
    });

    if (txn.status !== 'SUCCESS') {
      const msgs = (txn.messages || []).map(m => m.text).join('; ');
      throw new Error(`Shippo label purchase failed: ${msgs}`);
    }

    return txn;
  }, 2, 1000);

  return {
    trackingNumber:   transaction.trackingNumber,
    trackingUrl:      transaction.trackingUrlProvider,
    labelUrl:         transaction.labelUrl,
    carrier:          selectedRate.provider,
    serviceName:      selectedRate.servicelevel?.name || selectedRate.provider,
    rateAmount:       parseFloat(selectedRate.amount),
    currency:         selectedRate.currency
  };
}

export async function getTrackingStatus(carrier, trackingNumber) {
  const shippo = getShippo();
  return retryWithBackoff(() => 
    shippo.trackingStatus.get({ carrier, trackingNumber })
  );
}

function _totalWeightKg(items) {
  return (items || []).reduce((sum, item) => sum + (parseFloat(item.weightKg || 0.5) * (item.quantity || 1)), 0);
}

function _totalLength(items) {
  const totalQty = (items || []).reduce((sum, item) => sum + (item.quantity || 1), 0);
  return Math.min(60, 20 + (totalQty * 2));
}

export default {
  validateAddress,
  getShippingRates,
  createShipment,
  getTrackingStatus
};
