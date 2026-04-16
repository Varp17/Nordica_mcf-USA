import express from 'express';
import db from '../config/database.js';
import * as Product from '../models/Product.js';
import mcfService from '../services/mcfService.js';
import shippoService from '../services/shippoService.js';
import logger from '../utils/logger.js';

import { authenticateToken as requireAuth, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

/**
 * POST /api/fulfillment/fetch-dimensions
 * Fetch product dimensions from Amazon MCF catalog
 */
router.post('/fetch-dimensions', requireAdmin, async (req, res) => {
  try {
    const { sku } = req.body;

    if (!sku) {
      return res.status(400).json({ success: false, message: 'SKU is required' });
    }

    const dimensionData = await mcfService.getProductDimensionsFromMCF(sku);

    // Update database if dimensions found
    if (dimensionData.dimensions && dimensionData.weight_kg) {
      await db.query(
        'UPDATE products SET weight_kg = ?, dimensions = ?, updated_at = NOW() WHERE amazon_sku = ?',
        [dimensionData.weight_kg, dimensionData.dimensions, sku]
      );
    }

    return res.json({
      success: true,
      dimensions: dimensionData
    });

  } catch (err) {
    logger.error(`POST /api/fulfillment/fetch-dimensions error: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to fetch dimensions from Amazon'
    });
  }
});
router.post('/preview', async (req, res) => {
  try {
    const { country, shipping, items } = req.body;

    if (country !== 'US') {
      return res.status(400).json({ success: false, message: 'Preview only available for US' });
    }

    // 1. Validate items
    logger.info('[DEBUG] Incoming items for preview:', { items });
    const { valid, errors, items: validatedItems } = await Product.validateCartItems(items, country);
    if (!valid) {
      return res.status(400).json({ success: false, message: 'Cart validation failed', errors });
    }

    const address = {
      name: `${shipping?.firstName || ''} ${shipping?.lastName || ''}`.trim() || 'Valued Customer',
      line1: shipping?.address1 || shipping?.address,
      city: shipping?.city,
      stateOrRegion: shipping?.state,
      postalCode: shipping?.zip,
      countryCode: 'US'
    };

    let dynamicPreviews = [];
    try {
      const amzPreviews = await mcfService.getFulfillmentPreview(address, validatedItems);
      dynamicPreviews = amzPreviews.map(p => {
        const estDays = p.fulfillmentPreviewShipments?.[0]?.latestArrival 
            ? Math.max(1, Math.ceil((new Date(p.fulfillmentPreviewShipments[0].latestArrival) - new Date()) / (1000 * 60 * 60 * 24)))
            : null;

        const flatRates = { 'Standard': 5, 'Expedited': 7, 'Priority': 15 };
        const customerCharge = flatRates[p.shippingSpeedCategory] || 0;
        const margin = customerCharge - p.totalFee;

        // Log the actual Amazon Fee vs what we charge (Sustainability check)
        logger.info(`[MCF COST ANALYSIS] Speed: ${p.shippingSpeedCategory.padEnd(9)} | Amazon Fee: ${p.totalFee.toString().padEnd(6)} | Customer: $${customerCharge.toString().padEnd(4)} | LOSS: $${margin.toFixed(2)} | Fulfillable: ${p.isFulfillable}`);

        return {
            ...p,
            id: p.shippingSpeedCategory.toLowerCase(),
            name: `${p.shippingSpeedCategory} Shipping`,
            price: customerCharge,
            currency: p.currency || 'USD',
            estimation: estDays ? `Estimated ${estDays - 2}-${estDays} business days` : 'Reliable Delivery',
            shippingSpeedCategory: p.shippingSpeedCategory,
            isDynamic: false
        };
      });
    } catch (e) {
      logger.error('Failed to fetch dynamic previews', { error: e.message });
    }

    const getEst = (speed, defaultEst) => {
        const dp = dynamicPreviews.find(d => d.shippingSpeedCategory === speed);
        return dp?.estimation || defaultEst;
    };

    // User requested flat rates: Standard $5, Expedited $7, Priority $15
    const allOptions = [
      {
        id: 'standard',
        name: 'Standard Shipping',
        price: 5.00,
        currency: 'USD',
        estimation: getEst('Standard', 'Estimated 3-5 business days'),
        shippingSpeedCategory: 'Standard'
      },
      {
        id: 'expedited',
        name: 'Expedited Shipping',
        price: 7.00,
        currency: 'USD',
        estimation: getEst('Expedited', 'Estimated 2-3 business days'),
        shippingSpeedCategory: 'Expedited'
      },
      {
        id: 'priority',
        name: 'Priority Shipping',
        price: 15.00,
        currency: 'USD',
        estimation: getEst('Priority', 'Estimated 1-2 business days'),
        shippingSpeedCategory: 'Priority'
      }
    ];

    // Filter only those that Amazon confirms are fulfillable for this address
    const availableSpeeds = new Set(
        dynamicPreviews
            .filter(p => p.isFulfillable)
            .map(p => p.shippingSpeedCategory)
    );
    
    const validPreviews = allOptions.filter(o => availableSpeeds.has(o.shippingSpeedCategory));

    if (validPreviews.length === 0) {
        return res.json({ 
            success: false, 
            message: 'Delivery not available at your place. Please verify your address or contact support.',
            previews: [] 
        });
    }

    return res.json({ 
      success: true, 
      previews: validPreviews
    });
  } catch (err) {
    logger.error(`POST /api/fulfillment/preview error: ${err.message}`, {
      stack: err.stack,
      requestItems: req.body?.items?.map(i => i.sku || i.id)
    });
    
    // EDGE CASE #55: Return 500 for actual server errors, or keep 200 with success: false for "business" errors
    return res.status(500).json({ 
      success: false, 
      message: err.message || 'Unable to fetch real-time shipping rates from Amazon. Please verify your address or contact support.'
    });
  }
});

/**
 * POST /api/fulfillment/rates (CA only)
 * Backend equivalent for frontend's fulfillment.rates()
 */
router.post('/rates', async (req, res) => {
  try {
    const { country, shipping, items } = req.body;

    if (country !== 'CA') {
      return res.status(400).json({ success: false, message: 'Rates only available for CA' });
    }

    const { valid, errors, items: validatedItems } = await Product.validateCartItems(items, country);
    if (!valid) {
      return res.status(400).json({ success: false, message: 'Cart validation failed', errors });
    }

    const totalQty = validatedItems.reduce((sum, item) => sum + (item.quantity || 1), 0);
    const fixedRate = {
        id: 'standard_ca',
        name: 'Standard Shipping',
        price: parseFloat((totalQty * 10).toFixed(2)),
        currency: 'CAD',
        estimation: 'Estimated 3-7 business days',
        isFulfillable: true
    };

    return res.json({ 
        success: true, 
        rates: [fixedRate]
    });
  } catch (err) {
    logger.error(`POST /api/fulfillment/rates error: ${err.message}`);
    // EDGE CASE #56: Return 500 for server errors
    return res.status(500).json({ 
        success: false, 
        message: err.message || 'Unable to fetch shipping rates. Double check your postal code or contact support.'
    });
  }
});

/**
 * POST /api/fulfillment/validate-address
 */
router.post('/validate-address', async (req, res) => {
    try {
        const address = req.body;
        const result = await shippoService.validateAddress({
            firstName: address.firstName,
            lastName: address.lastName,
            address1: address.address1,
            city: address.city,
            state: address.province || address.state,
            province: address.province || address.state,
            zip: address.postalCode || address.zip,
            postalCode: address.postalCode || address.zip,
            country: address.country || 'US'
        });
        
        // Return 200 but including the 'valid' flag and details
        return res.json({ 
            success: true, 
            valid: result.valid,
            fieldErrors: result.fieldErrors,
            correctedAddress: result.correctedAddress,
            validation_results: result 
        });
    } catch (err) {
        logger.error(`POST /api/fulfillment/validate-address error: ${err.message}`);
        return res.status(500).json({ success: false, message: 'Internal validation error', error: err.message });
    }
});

/**
 * POST /api/fulfillment/calculate-tax
 * Returns applicable tax for an order.
 * Canada: $0 (tax handled at label/invoice level offline)
 * USA: basic state-rate lookup
 */
router.post('/calculate-tax', async (req, res) => {
  try {
    const { country, state, subtotal } = req.body;
    const sub = parseFloat(subtotal) || 0;

    if (country === 'CA') {
      const province = (req.body.province || state || '').toUpperCase();
      // EDGE CASE #57: Use same tax rates as orderRoutes.js (Synchronized)
      const CA_TAX_RATES = {
        'AB': 0.05, 'BC': 0.12, 'MB': 0.12, 'NB': 0.15, 'NL': 0.15, 'NS': 0.15, 
        'NT': 0.05, 'NU': 0.05, 'ON': 0.13, 'PE': 0.15, 'QC': 0.14975, 'SK': 0.11, 'YT': 0.05
      };
      
      const rate = CA_TAX_RATES[province] ?? 0;
      const tax = parseFloat((sub * rate).toFixed(2));
      const label = rate >= 0.12 ? `HST/PST/QST (${(rate*100).toFixed(2)}%)` : `GST (${(rate*100).toFixed(0)}%)`;
      
      return res.json({ success: true, tax, tax_label: label, rate });
    }

    // US state tax rates
    // EDGE CASE #58: Added more states for better coverage
    const US_TAX_RATES = {
      AL: 0.04, AK: 0, AZ: 0.056, AR: 0.065, CA: 0.0725, CO: 0.029, CT: 0.0635,
      DE: 0, FL: 0.06, GA: 0.04, HI: 0.04, ID: 0.06, IL: 0.0625, IN: 0.07,
      IA: 0.06, KS: 0.065, KY: 0.06, LA: 0.0445, ME: 0.055, MD: 0.06,
      MA: 0.0625, MI: 0.06, MN: 0.06875, MS: 0.07, MO: 0.04225, MT: 0,
      NE: 0.055, NV: 0.0685, NH: 0, NJ: 0.0663, NM: 0.05125, NY: 0.08,
      NC: 0.0475, ND: 0.05, OH: 0.0575, OK: 0.045, OR: 0, PA: 0.06,
      RI: 0.07, SC: 0.06, SD: 0.045, TN: 0.07, TX: 0.0625, UT: 0.0610,
      VT: 0.06, VA: 0.053, WA: 0.065, WV: 0.06, WI: 0.05, WY: 0.04,
      DC: 0.06
    };

    const rate = US_TAX_RATES[state?.toUpperCase()] ?? 0;
    const tax = parseFloat((sub * rate).toFixed(2));

    return res.json({ success: true, tax, tax_label: 'Sales Tax', rate });
  } catch (err) {
    logger.error(`POST /api/fulfillment/calculate-tax error: ${err.message}`);
    return res.json({ success: true, tax: 0, tax_label: 'Tax', rate: 0 });
  }
});

export default router;
