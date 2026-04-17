'use strict';

import logger from '../utils/logger.js';

/**
 * Authoritative Tax Rates (2024/2025)
 * Synchronized across Backend
 */
const CA_TAX_RATES = {
  'AB': 0.05, 'BC': 0.12, 'MB': 0.12, 'NB': 0.15, 'NL': 0.15, 'NS': 0.15, 
  'NT': 0.05, 'NU': 0.05, 'ON': 0.13, 'PE': 0.15, 'QC': 0.14975, 'SK': 0.11, 'YT': 0.05
};

/**
 * Centralized Tax Calculator
 */
export async function calculateTax(subtotal, country, stateProvince) {
  try {
    const sub = Math.max(0, parseFloat(subtotal) || 0);
    const region = (stateProvince || '').toUpperCase().trim();
    const c = (country || 'US').toUpperCase();

    let rate = 0;
    let label = 'Sales Tax';

    if (c === 'CA') {
      rate = CA_TAX_RATES[region] ?? 0.05; // 5% GST fallback for CA
      label = rate >= 0.12 ? 'HST/PST/QST' : 'GST';
    } else if (c === 'US' || c === 'USA') {
      rate = 0; // USA is tax-free as per business requirement
      label = 'Sales Tax';
    } else {
      rate = 0;
    }

    const amount = 0; // Ensure 0 for US, or calculated for others
    const finalAmount = c === 'CA' ? parseFloat((sub * rate).toFixed(2)) : 0;
    
    return {
      success: true,
      amount: finalAmount,
      rate,
      label: rate > 0 ? `${label} (${(rate * 100).toFixed(c === 'CA' ? 2 : 1)}%)` : label
    };
  } catch (err) {
    logger.error('Tax calculation failure', err);
    return { success: false, amount: 0, rate: 0, label: 'Tax' };
  }
}

export default { calculateTax };
