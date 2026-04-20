import axios from 'axios';
import db from '../config/database.js';
import logger from '../utils/logger.js';

const FRAUDLABS_PRO_API = 'https://api.fraudlabspro.com/v2/order/screen';
const FRAUDLABS_PRO_TIMEOUT = 10000; // 10 seconds

/**
 * Fraud Detection Service
 * ────────────────────────
 * Uses FraudLabs Pro v2 API (free tier: 500 queries/month)
 * to screen orders for fraud before fulfillment.
 *
 * Design: FAIL-OPEN
 * If the API key is missing, disabled, or the API is unreachable,
 * orders proceed normally (approved). We never block a paying customer
 * due to an infrastructure failure.
 *
 * FraudLabs Pro returns:
 *   fraudlabspro_status: 'APPROVE' | 'REVIEW' | 'REJECT'
 *   fraudlabspro_score: 0-100 (higher = riskier)
 */

/**
 * Check if fraud screening is enabled and configured
 */
function isEnabled() {
  const key = process.env.FRAUDLABS_PRO_API_KEY;
  const enabled = process.env.FRAUD_CHECK_ENABLED !== 'false';
  return enabled && key && key.trim().length > 0;
}

/**
 * Screen an order for fraud via FraudLabs Pro v2 API
 *
 * @param {Object} order  - The order row from DB (must have shipping/billing fields)
 * @param {string} clientIp - The customer's IP address from the request
 * @returns {Object} { isApproved, isReview, isRejected, score, status, fraudlabsproId, rawResponse }
 */
export async function screenOrder(order, clientIp) {
  // Default: pass-through (approved)
  const passthrough = {
    isApproved: true,
    isReview: false,
    isRejected: false,
    score: 0,
    status: 'PASSTHROUGH',
    fraudlabsproId: null,
    provider: 'none',
    rawResponse: null,
    error: null
  };

  if (!isEnabled()) {
    logger.debug('Fraud check skipped: FRAUDLABS_PRO_API_KEY not configured or FRAUD_CHECK_ENABLED=false');
    return passthrough;
  }

  try {
    const apiKey = process.env.FRAUDLABS_PRO_API_KEY.trim();
    const shipping = order.shipping_address ? (typeof order.shipping_address === 'string' ? JSON.parse(order.shipping_address) : order.shipping_address) : {};

    // Build the screening payload
    const payload = {
      key: apiKey,
      format: 'json',

      // Customer IP (critical for geo-fraud detection)
      ip: clientIp || '127.0.0.1',

      // Order details
      user_order_id: order.order_number || order.id,
      user_order_memo: `${order.country || 'US'} order via PayPal`,
      amount: parseFloat(order.total || 0).toFixed(2),
      quantity: (order.items || []).reduce((sum, i) => sum + (i.quantity || 1), 0) || 1,
      currency: order.currency || 'USD',
      payment_gateway: 'paypal',
      payment_mode: 'paypal',

      // Customer contact
      email: order.customer_email || order.cust_email || '',
      first_name: order.shipping_first_name || shipping.firstName || '',
      last_name: order.shipping_last_name || shipping.lastName || '',
      user_phone: order.shipping_phone || shipping.phone || '',

      // Billing address (use shipping as billing for PayPal — PayPal handles billing separately)
      bill_addr: order.shipping_address1 || shipping.address1 || '',
      bill_city: order.shipping_city || shipping.city || '',
      bill_state: order.shipping_state || order.shipping_province || shipping.state || shipping.province || '',
      bill_zip_code: order.shipping_zip || order.shipping_postal_code || shipping.zip || shipping.postalCode || '',
      bill_country: order.country || 'US',

      // Shipping address
      ship_first_name: order.shipping_first_name || shipping.firstName || '',
      ship_last_name: order.shipping_last_name || shipping.lastName || '',
      ship_addr: order.shipping_address1 || shipping.address1 || '',
      ship_city: order.shipping_city || shipping.city || '',
      ship_state: order.shipping_state || order.shipping_province || shipping.state || shipping.province || '',
      ship_zip_code: order.shipping_zip || order.shipping_postal_code || shipping.zip || shipping.postalCode || '',
      ship_country: order.country || 'US',
    };

    logger.info(`[FRAUD] Screening order ${order.order_number || order.id} (IP: ${clientIp || 'unknown'})`);

    const response = await axios({
      url: FRAUDLABS_PRO_API,
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      data: payload,
      timeout: FRAUDLABS_PRO_TIMEOUT,
    });

    const data = response.data;

    // FraudLabs Pro v2 returns fraudlabspro_status and fraudlabspro_score
    const flpStatus = (data.fraudlabspro_status || '').toUpperCase();
    const flpScore = parseInt(data.fraudlabspro_score) || 0;
    const flpId = data.fraudlabspro_id || null;

    // Check custom score threshold override
    const customThreshold = parseInt(process.env.FRAUD_SCORE_THRESHOLD) || 0;
    let finalStatus = flpStatus;

    if (customThreshold > 0 && flpScore >= customThreshold && flpStatus === 'APPROVE') {
      // Override: score exceeds custom threshold even though API approved
      finalStatus = 'REVIEW';
      logger.warn(`[FRAUD] Order ${order.order_number}: API approved but score ${flpScore} >= threshold ${customThreshold}. Overriding to REVIEW.`);
    }

    const result = {
      isApproved: finalStatus === 'APPROVE',
      isReview: finalStatus === 'REVIEW',
      isRejected: finalStatus === 'REJECT',
      score: flpScore,
      status: finalStatus,
      fraudlabsproId: flpId,
      provider: 'fraudlabspro',
      rawResponse: data,
      error: null
    };

    logger.info(`[FRAUD] Order ${order.order_number}: Status=${finalStatus}, Score=${flpScore}, ID=${flpId}`);

    // Persist fraud result to database
    await _persistFraudResult(order.id, result);

    return result;

  } catch (err) {
    // FAIL-OPEN: If the fraud API is down, don't block the customer
    logger.error(`[FRAUD] API Error screening order ${order.order_number || order.id}: ${err.message}`);

    const failOpenResult = {
      ...passthrough,
      status: 'API_ERROR',
      error: err.message
    };

    // Still persist the error so admins can see it
    try {
      await _persistFraudResult(order.id, failOpenResult);
    } catch (dbErr) {
      logger.error(`[FRAUD] Failed to persist API error result: ${dbErr.message}`);
    }

    return failOpenResult;
  }
}

/**
 * Persist fraud screening result to the orders table
 */
async function _persistFraudResult(orderId, result) {
  try {
    const statusMap = {
      'APPROVE': 'approved',
      'REVIEW': 'review',
      'REJECT': 'rejected',
      'PASSTHROUGH': 'passthrough',
      'API_ERROR': 'error'
    };

    await db.execute(
      `UPDATE orders SET 
         fraud_status = ?, 
         fraud_score = ?, 
         fraud_provider = ?, 
         fraud_reference = ?,
         fraud_checked_at = NOW(),
         updated_at = NOW()
       WHERE id = ?`,
      [
        statusMap[result.status] || result.status?.toLowerCase() || null,
        result.score || null,
        result.provider || null,
        result.fraudlabsproId || null,
        orderId
      ]
    );
  } catch (err) {
    logger.error(`[FRAUD] Failed to persist fraud result for order ${orderId}: ${err.message}`);
  }
}

/**
 * Determine if an order should be held (not fulfilled) based on fraud screening
 * @param {Object} fraudResult - Result from screenOrder()
 * @returns {boolean} true if order should be held
 */
export function shouldHoldOrder(fraudResult) {
  if (!fraudResult) return false;
  return fraudResult.isReview || fraudResult.isRejected;
}

/**
 * Admin action: approve a held order and trigger fulfillment
 */
export async function adminApproveFraud(orderId) {
  await db.execute(
    `UPDATE orders SET fraud_status = 'admin_approved', updated_at = NOW() WHERE id = ?`,
    [orderId]
  );
  logger.info(`[FRAUD] Admin approved order ${orderId} — releasing for fulfillment`);
}

/**
 * Admin action: reject a held order
 */
export async function adminRejectFraud(orderId) {
  await db.execute(
    `UPDATE orders SET fraud_status = 'admin_rejected', status = 'cancelled', fulfillment_status = 'cancelled', updated_at = NOW() WHERE id = ?`,
    [orderId]
  );
  logger.info(`[FRAUD] Admin rejected order ${orderId} — order cancelled`);
}

export default { screenOrder, shouldHoldOrder, adminApproveFraud, adminRejectFraud };
