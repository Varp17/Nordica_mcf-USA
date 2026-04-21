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
 * ── Carton Dimensions ────────────────────────────────────────────────────────
 */
const CARTONS = [
  { name: 'Mailer #3 - Smallest', length: 33.0, width: 22.9, height: 6.4, weight_kg: 0.045, l_in: 13, w_in: 9, h_in: 2.5 },
  { name: 'Mailer #7 - Large', length: 45.7, width: 35.6, height: 6.4, weight_kg: 0.068, l_in: 18, w_in: 14, h_in: 2.5 },
  { name: '12" BOX', length: 30.5, width: 30.5, height: 38.1, weight_kg: 0.453, l_in: 12, w_in: 12, h_in: 15 },
  { name: '15" BOX', length: 38.1, width: 38.1, height: 38.1, weight_kg: 0.453, l_in: 15, w_in: 15, h_in: 15 },
  { name: 'LARGE 24" BOX', length: 61.0, width: 33.0, height: 45.7, weight_kg: 0.45, l_in: 24, w_in: 13, h_in: 18 }
];

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
 * Create a Shippo Order (for manual confirmation in Shippo Dashboard)
 */
export async function createOrder(order) {
  const headers = getAuthHeaders();
  const { totalLength, totalWidth, totalHeight, totalWeight, selectedCarton } = _calculatePackageDimensions(order.items || []);

  const fromAddress = {
    name:    process.env.SHIPPO_FROM_NAME    || 'Nordica Warehouse',
    street1: process.env.SHIPPO_FROM_STREET1 || '1905 Sismet Rd',
    city:    process.env.SHIPPO_FROM_CITY    || 'Mississauga',
    state:   process.env.SHIPPO_FROM_STATE   || 'ON',
    zip:     process.env.SHIPPO_FROM_ZIP     || 'L4W4H4',
    country: process.env.SHIPPO_FROM_COUNTRY || 'CA',
    phone:   process.env.SHIPPO_FROM_PHONE   || '905-624-5504',
    email:   process.env.SHIPPO_FROM_EMAIL   || 'info@nordicaplastics.ca'
  };

  const lineItems = (order.items || []).map(item => ({
    quantity: parseInt(item.quantity) || 1,
    sku: item.actual_sku || item.sku || 'N/A',
    title: item.product_name,
    total_price: item.total_price,
    currency: order.currency || 'CAD',
    weight: parseFloat(parseFloat(item.weight_kg || item.weightKg || 0.5).toFixed(2)),
    weight_unit: 'kg',
    url: item.image_url_at_purchase || item.image || item.fallback_image || '',
    image_url: item.image_url_at_purchase || item.image || item.fallback_image || ''
  }));

  // Check for Fraud/Risk flags to alert the manual fulfillment process
  const isFraudHold = order.fraud_status === 'review' || order.fraud_status === 'rejected' || order.fraud_status === 'flagged';
  const fraudNote = isFraudHold ? `⚠️ FRAUD ALERT: Status is ${order.fraud_status.toUpperCase()}. Verify before shipping!\n` : '';

  // Construct a descriptive note for the Shippo dashboard
  const cartonNote = selectedCarton ? `Box: ${selectedCarton.name}` : `Custom Box: ${totalLength}x${totalWidth}x${totalHeight} cm`;
  const shippingNote = order.service_name ? `Method: ${order.service_name}` : `Speed: ${order.shipping_speed || 'standard'}`;
  const notes = `${fraudNote}${shippingNote}\n${cartonNote}\nWeight: ${totalWeight} kg\nItems: ${order.items?.length || 0}`;

  const orderData = {
    to_address: {
      name: `${order.shipping_first_name} ${order.shipping_last_name}`.trim(),
      street1: order.shipping_address1,
      street2: order.shipping_address2 || '',
      city: order.shipping_city,
      state: order.shipping_state || order.shipping_province || '',
      zip: (order.shipping_zip || order.shipping_postal_code || '').replace(/\s+/g, '').toUpperCase(),
      country: (order.country || 'CA').toUpperCase(),
      phone: order.shipping_phone || '',
      email: order.customer_email || ''
    },
    from_address: fromAddress,
    line_items: lineItems,
    placed_at: order.created_at || new Date().toISOString(),
    order_number: order.order_number,
    order_status: isFraudHold ? 'ON_HOLD' : 'PAID',
    notes: notes,
    shipping_cost: order.shipping_cost,
    shipping_cost_currency: order.currency || 'CAD',
    shipping_method: order.service_name || order.shipping_speed || 'Standard',
    weight: totalWeight,
    weight_unit: 'kg'
  };

  try {
    const shippoOrder = await axios.post('https://api.goshippo.com/orders/', orderData, { headers }).then(r => r.data);

    return {
      shippoOrderId: shippoOrder.object_id,
      orderNumber: shippoOrder.order_number,
      status: shippoOrder.order_status,
      selectedCarton: selectedCarton?.name || 'Custom'
    };
  } catch (err) {
    if (err.response) {
      logger.error(`Shippo API Error [Order]: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

/**
 * Purchase Label and Create Shipment (Directly)
 * Note: Use createOrder instead if manual confirmation is desired.
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
 * Fetch Shippo Order details
 */
export async function getOrder(shippoOrderId) {
  const headers = getAuthHeaders();
  const res = await axios.get(`https://api.goshippo.com/orders/${shippoOrderId}/`, { headers });
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

  let totalWeight = 0;
  let maxL = 0, maxW = 0, maxH = 0;
  let totalVolume = 0;

  for (const item of items) {
    const qty = Math.max(1, parseInt(item.quantity) || 1);
    const weight = Math.max(0.1, parseFloat(item.weight_kg || item.weightKg || 0.5));
    totalWeight += weight * qty;

    let l = 20, w = 15, h = 10;
    const dimStr = String(item.dimensions || '20x15x10');
    const parts = dimStr.split('x').map(p => parseFloat(p) || 0);
    if (parts.length >= 3) { [l, w, h] = parts; }

    maxL = Math.max(maxL, l);
    maxW = Math.max(maxW, w);
    maxH = Math.max(maxH, h);
    totalVolume += (l * w * h) * qty;
  }

  // Find the smallest CARTON that fits these items
  // Heuristic: Carton volume must be >= items volume AND carton must be large enough for the biggest item
  // We add 20% volume padding for packing material
  const paddedVolume = totalVolume * 1.2;

  let selectedCarton = CARTONS.find(c => 
    (c.length * c.width * c.height) >= paddedVolume && 
    c.length >= maxL && 
    c.width >= maxW && 
    c.height >= maxH
  );
  
  // If no standard carton fits, fallback to dynamic dimensions
  if (!selectedCarton) {
    // Basic fallback: assume they stack in height if nothing else works
    const sumH = items.reduce((sum, i) => sum + ((parseFloat(String(i.dimensions || '10').split('x')[2]) || 10) * (i.quantity || 1)), 0);
    
    return {
      totalLength: Math.max(15, parseFloat((maxL + 2).toFixed(2))),
      totalWidth: Math.max(10, parseFloat((maxW + 2).toFixed(2))),
      totalHeight: Math.max(5, parseFloat((sumH + 2).toFixed(2))),
      totalWeight: Math.max(0.1, parseFloat(totalWeight.toFixed(2))),
      selectedCarton: null
    };
  }

  return {
    totalLength: selectedCarton.length,
    totalWidth: selectedCarton.width,
    totalHeight: selectedCarton.height,
    totalWeight: Math.max(0.1, parseFloat((totalWeight + selectedCarton.weight_kg).toFixed(2))),
    selectedCarton
  };
}

const shippoService = {
  getShippo,
  validateAddress,
  getShippingRates,
  createShipment,
  createOrder,
  getOrder,
  registerTracking,
  getTrackingStatus,
  refundLabel
};

export default shippoService;
