'use strict';

/**
 * Tax Calculation Service
 * ────────────────────────
 * Provides dynamic, authoritative tax calculations for US and Canada.
 * Refactored for ESM.
 *
 * LOSS PREVENTION STRATEGY:
 * Includes the state-level base + a conservative local-tax buffer 
 * for US states to minimize accidental under-collection.
 */

import logger from '../utils/logger.js';

// ── Canadian Provincial Tax Rates (2024 GST/HST/PST combinations) ────────────
const CA_TAX_RATES = {
  'AB': { rate: 0.05,    name: 'GST',     description: 'Alberta (5% GST)' },
  'BC': { rate: 0.12,    name: 'GST+PST', description: 'British Columbia (5% GST + 7% PST)' },
  'MB': { rate: 0.12,    name: 'GST+PST', description: 'Manitoba (5% GST + 7% PST)' },
  'NB': { rate: 0.15,    name: 'HST',     description: 'New Brunswick (15% HST)' },
  'NL': { rate: 0.15,    name: 'HST',     description: 'Newfoundland/Labrador (15% HST)' },
  'NS': { rate: 0.15,    name: 'HST',     description: 'Nova Scotia (15% HST)' },
  'NT': { rate: 0.05,    name: 'GST',     description: 'Northwest Territories (5% GST)' },
  'NU': { rate: 0.05,    name: 'GST',     description: 'Nunavut (5% GST)' },
  'ON': { rate: 0.13,    name: 'HST',     description: 'Ontario (13% HST)' },
  'PE': { rate: 0.15,    name: 'HST',     description: 'Prince Edward Island (15% HST)' },
  'QC': { rate: 0.14975, name: 'GST+QST', description: 'Quebec (5% GST + 9.975% QST)' },
  'SK': { rate: 0.11,    name: 'GST+PST', description: 'Saskatchewan (5% GST + 6% PST)' },
  'YT': { rate: 0.05,    name: 'GST',     description: 'Yukon (5% GST)' }
};

// ── US State Base Sales Tax (Full 50-State "Safe Rates") ────────────────────
// Rates include a state base + typical local buffer to prevent business loss.
const US_TAX_RATES = {
  'AL': 0.09, 'AK': 0.00, 'AZ': 0.084, 'AR': 0.095, 'CA': 0.0825,
  'CO': 0.077, 'CT': 0.0635, 'DE': 0.00, 'FL': 0.07, 'GA': 0.07,
  'HI': 0.045, 'ID': 0.06, 'IL': 0.088, 'IN': 0.07, 'IA': 0.07,
  'KS': 0.087, 'KY': 0.06, 'LA': 0.095, 'ME': 0.055, 'MD': 0.06,
  'MA': 0.0625, 'MI': 0.06, 'MN': 0.075, 'MS': 0.07, 'MO': 0.08,
  'MT': 0.00, 'NE': 0.065, 'NV': 0.082, 'NH': 0.00, 'NJ': 0.06625,
  'NM': 0.078, 'NY': 0.08875, 'NC': 0.07, 'ND': 0.068, 'OH': 0.0725,
  'OK': 0.089, 'OR': 0.00, 'PA': 0.06, 'RI': 0.07, 'SC': 0.074,
  'SD': 0.06, 'TN': 0.095, 'TX': 0.0825, 'UT': 0.07, 'VT': 0.06,
  'VA': 0.053, 'WA': 0.092, 'WV': 0.064, 'WI': 0.055, 'WY': 0.054
};

/**
 * calculateTax
 * 
 * @param {object} params
 * @param {string} params.country  - 'US' | 'CA'
 * @param {string} params.state    - State/Province code (e.g. 'ON', 'CA', 'TX')
 * @param {number} params.subtotal - Cart subtotal amount
 * @param {number} params.shipping - Shipping cost
 * @param {string} params.zip      - Postal/Zip code (reserved for real API lookup)
 */
export async function calculateTax({ country, state, subtotal, shipping = 0, zip }) {
  try {
    const taxableAmount = (parseFloat(subtotal) || 0) + (parseFloat(shipping) || 0);
    
    // ── Future Bridge: Real API Placeholder ────────────────────────
    if (process.env.TAXJAR_API_KEY) {
      // return await calculateWithTaxJar({ ... });
    }

    let rate = 0;
    let label = 'Taxes';
    let detail = '';

    const upperState = (state || '').toUpperCase().trim();

    if (country === 'CA') {
      const caInfo = CA_TAX_RATES[upperState] || { rate: 0.05, name: 'GST', description: 'Canada-wide GST fallback' };
      rate = caInfo.rate;
      label = caInfo.name;
      detail = caInfo.description;
    } 
    else if (country === 'US' || country === 'USA') {
      rate = US_TAX_RATES[upperState] || 0.00;
      label = 'Sales Tax';
      detail = `Estimated ${upperState} Sales Tax (${(rate * 100).toFixed(2)}%)`;
    }

    const amount = parseFloat((taxableAmount * rate).toFixed(2));

    logger.debug(`Tax Calculated for ${country}/${state}: Rate ${rate} on taxable amount ${taxableAmount} -> Total Tax ${amount}`);

    return {
      success: true,
      rate,
      amount,
      label,
      detail,
      is_estimated: true // Important for production transparency
    };
  } catch (err) {
    logger.error(`taxService: Failed to calculate tax for ${country}/${state}: ${err.message}`);
    // Safe fallback to prevent order blocks, but you may want to return 0.05 as a safety
    return { success: false, rate: 0, amount: 0, label: 'Tax', error: err.message };
  }
}

export default {
  calculateTax
};
