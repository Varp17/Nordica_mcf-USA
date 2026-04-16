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

const US_TAX_RATES = {
  AL: 0.04, AK: 0, AZ: 0.056, AR: 0.065, CA: 0.0725, CO: 0.029, CT: 0.0635,
  DE: 0, FL: 0.06, GA: 0.04, HI: 0.04, ID: 0.06, IL: 0.0625, IN: 0.07,
  IA: 0.06, KS: 0.065, KY: 0.06, LA: 0.0445, ME: 0.055, MD: 0.06,
  MA: 0.0625, MI: 0.06, MN: 0.06875, MS: 0.07, MO: 0.04225, MT: 0,
  NE: 0.055, NV: 0.0685, NH: 0, NJ: 0.0663, NM: 0.05125, NY: 0.08,
  NC: 0.0475, ND: 0.05, OH: 0.0575, OK: 0.045, OR: 0, PA: 0.06,
  RI: 0.07, SC: 0.06, SD: 0.045, TN: 0.07, TX: 0.0625, UT: 0.0610,
  VT: 0.06, VA: 0.053, WA: 0.065, WV: 0.06, WI: 0.05, WY: 0.04, DC: 0.06
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
    } else {
      rate = US_TAX_RATES[region] ?? 0;
    }

    const amount = parseFloat((sub * rate).toFixed(2));
    
    return {
      success: true,
      amount,
      rate,
      label: `${label} (${(rate * 100).toFixed(c === 'CA' ? 2 : 1)}%)`
    };
  } catch (err) {
    logger.error('Tax calculation failure', err);
    return { success: false, amount: 0, rate: 0, label: 'Tax' };
  }
}

export default { calculateTax };
