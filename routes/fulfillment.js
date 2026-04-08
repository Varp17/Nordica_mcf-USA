import express from 'express';
import db from '../config/database.js';
import * as Product from '../models/Product.js';
import mcfService from '../services/mcfService.js';
import shippoService from '../services/shippoService.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * POST /api/fulfillment/fetch-dimensions
 * Fetch product dimensions from Amazon MCF catalog
 */
router.post('/fetch-dimensions', async (req, res) => {
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

    const previews = await mcfService.getFulfillmentPreview(address, validatedItems);
    
    // The frontend expects { success: true, previews: [...] }
    return res.json({ 
      success: true, 
      previews: previews.map(p => {
        const estDays = p.fulfillmentPreviewShipments?.[0]?.latestArrival 
            ? Math.max(1, Math.ceil((new Date(p.fulfillmentPreviewShipments[0].latestArrival) - new Date()) / (1000 * 60 * 60 * 24)))
            : null;
            
        return {
            ...p,
            id: p.shippingSpeedCategory,
            name: `${p.shippingSpeedCategory} Shipping`,
            price: p.totalFee,
            currency: p.currency || 'USD',
            estimation: estDays ? `Estimated ${estDays - 2}-${estDays} business days` : 'Reliable Delivery'
        };
      })
    });
  } catch (err) {
    logger.error(`POST /api/fulfillment/preview error: ${err.message}`, {
      stack: err.stack,
      requestItems: req.body?.items?.map(i => i.sku || i.id)
    });
    
    return res.status(200).json({ 
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

    const rates = await shippoService.getShippingRates({
      shipping_first_name: shipping?.firstName,
      shipping_last_name: shipping?.lastName,
      shipping_address1: shipping?.address1 || shipping?.address,
      shipping_city: shipping?.city,
      shipping_province: shipping?.province || shipping?.state,
      shipping_postal_code: shipping?.postalCode || shipping?.zip,
      items: validatedItems
    });

    return res.json({ 
        success: true, 
        rates: rates.map(r => ({
            ...r,
            id: r.rateId,
            name: r.serviceName,
            price: r.amount,
            estimation: r.estimatedDays ? `Estimated ${r.estimatedDays} business days` : r.durationTerms || 'Reliable Delivery',
            isFulfillable: true
        })) 
    });
  } catch (err) {
    logger.error(`POST /api/fulfillment/rates error: ${err.message}`);
    return res.json({ 
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
      // Canadian GST/HST/PST is calculated at invoice time, not during checkout
      return res.json({ success: true, tax: 0, tax_label: 'Tax (incl.)', rate: 0 });
    }

    // US state tax rates (simplified — production would use TaxJar/Avalara)
    const US_TAX_RATES = {
      CA: 0.0725, NY: 0.08, TX: 0.0625, FL: 0.06, WA: 0.065,
      IL: 0.0625, PA: 0.06, OH: 0.0575, GA: 0.04, NC: 0.0475,
      MI: 0.06, NJ: 0.0663, VA: 0.053, AZ: 0.056, TN: 0.07,
      MA: 0.0625, IN: 0.07, MO: 0.04225, MD: 0.06, WI: 0.05,
      CO: 0.029, MN: 0.06875, SC: 0.06, AL: 0.04, LA: 0.0445,
      KY: 0.06, OR: 0, MT: 0, NH: 0, DE: 0, AK: 0
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
