'use strict';

/**
 * Tax Calculation Service
 * ────────────────────────
 * Provides dynamic tax calculations for US and Canada.
 *
 * Production version would integrate with:
 *  - TaxJar:  https://www.taxjar.com/
 *  - Avalara: https://www.avalara.com/
 *  - Stripe Tax: https://stripe.com/tax
 */

const logger = require('../utils/logger');

// ── Canadian Provincial Sales Tax (PST/GST/HST) ──────────────────────────────
// Rates as of 2024
const CA_TAX_RATES = {
  'ON': 0.13, // HST
  'QC': 0.14975, // GST (5%) + QST (9.975%)
  'BC': 0.12, // GST (5%) + PST (7%)
  'AB': 0.05, // GST only
  'MB': 0.12, // GST (5%) + PST (7%)
  'SK': 0.11, // GST (5%) + PST (6%)
  'NB': 0.15, // HST
  'NS': 0.15, // HST
  'PE': 0.15, // HST
  'NL': 0.15, // HST
  'NT': 0.05, // GST only
  'NU': 0.05, // GST only
  'YT': 0.05  // GST only
};

// ── US State Sales Tax (Estimated Averages) ──────────────────────────────────
// Note: In the US, tax is actually calculated at the local/county/city level.
// These state averages are for demonstration/mocking purposes.
const US_TAX_RATES = {
  'CA': 0.0825, // California approx (ranges 7.25% - 10.25%)
  'NY': 0.08875,
  'TX': 0.0825,
  'FL': 0.06,
  'IL': 0.0825,
  'WA': 0.09,
  'OR': 0.00, // No sales tax state
  'DE': 0.00,
  'NH': 0.00,
  'MT': 0.00,
  'PA': 0.06
};

/**
 * calculateTax
 *
 * @param {object} params
 * @param {string} params.country  - 'US' | 'CA'
 * @param {string} params.state    - State/Province code (e.g. 'ON', 'CA')
 * @param {number} params.subtotal - Amount before tax
 * @param {string} params.zip      - Postal/Zip code (used by real APIs)
 */
async function calculateTax({ country, state, subtotal, shipping = 0, zip }) {
  try {
    const taxableAmount = subtotal + parseFloat(shipping || 0);
    // ── Production Hook: Real API integration ────────────────────────────────
    // if (process.env.TAXJAR_API_KEY) {
    //   return await calculateWithTaxJar({ ... });
    // }

    let rate = 0;

    if (country === 'US') {
      rate = US_TAX_RATES[state?.toUpperCase()] || 0;
    } else if (country === 'CA') {
      rate = CA_TAX_RATES[state?.toUpperCase()] || 0.05; // Default to GST
    }

    const amount = parseFloat((taxableAmount * rate).toFixed(2));

    logger.debug(`Tax calculated: ${country}/${state} | Subtotal: ${subtotal} | Rate: ${rate} | Tax: ${amount}`);

    return {
      rate,
      amount,
      is_mock: true
    };
  } catch (err) {
    logger.error(`Tax calculation error: ${err.message}`);
    // Safe fallback: 0 tax rather than breaking checkout, or throw error based on policy
    return { rate: 0, amount: 0, error: err.message };
  }
}

module.exports = {
  calculateTax
};
