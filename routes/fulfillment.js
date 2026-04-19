import express from 'express';
import db from '../config/database.js';
import * as Product from '../models/Product.js';
import mcfService from '../services/mcfService.js';
import shippoService from '../services/shippoService.js';
import logger from '../utils/logger.js';
import taxService from '../services/taxService.js';

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

/**
 * POST /api/fulfillment/sync-price
 * Fetch price from Amazon and update local database
 */
router.post('/sync-price', requireAdmin, async (req, res) => {
  try {
    const { sku } = req.body;
    if (!sku) return res.status(400).json({ success: false, message: 'SKU is required' });

    const price = await mcfService.getProductPriceFromAmazon(sku);
    if (price === null) {
      return res.status(404).json({ success: false, message: 'Price not found on Amazon for this SKU' });
    }

    // Update variants first (most likely for Amazon SKUs)
    const [vRes] = await db.query('UPDATE product_variants SET price = ?, updated_at = NOW() WHERE amazon_sku = ?', [price, sku]);
    const [cvRes] = await db.query('UPDATE product_color_variants SET price = ?, updated_at = NOW() WHERE amazon_sku = ?', [price, sku]);
    const [pRes] = await db.query('UPDATE products SET price = ?, updated_at = NOW() WHERE amazon_sku = ?', [price, sku]);

    return res.json({
      success: true,
      price,
      updates: {
        variants: vRes.affectedRows,
        color_variants: cvRes.affectedRows,
        products: pRes.affectedRows
      }
    });

  } catch (err) {
    logger.error(`POST /api/fulfillment/sync-price error: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
});
/**
 * POST /api/fulfillment/sync-reviews
 * Fetch review count/rating from Amazon and update local database
 */
router.post('/sync-reviews', requireAdmin, async (req, res) => {
  try {
    const { asin, productId } = req.body;
    if (!asin || !productId) return res.status(400).json({ success: false, message: 'ASIN and Product ID are required' });

    const metadata = await mcfService.getAmazonCatalogMetadata(asin);
    
    // If Amazon API doesn't provide it (common for non-brand owners), 
    // we allow the user to know it's not available via this channel.
    if (!metadata || metadata.rating === null) {
      return res.status(404).json({ 
        success: false, 
        message: 'Review data not exposed by Amazon for this Listing via SP-API.' 
      });
    }

    await db.query(
      'UPDATE products SET rating = ?, review_count = ?, updated_at = NOW() WHERE id = ?',
      [metadata.rating, metadata.reviewCount, productId]
    );

    return res.json({
      success: true,
      rating: metadata.rating,
      reviewCount: metadata.reviewCount
    });

  } catch (err) {
    logger.error(`POST /api/fulfillment/sync-reviews error: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/preview', async (req, res) => {
  try {
    const { country, shipping, items } = req.body;

    if (country !== 'US') {
      return res.status(400).json({ success: false, message: 'Preview only available for US' });
    }

    // 1. Validate items
    // FIX: Changed from logger.info to logger.debug for production
    logger.debug('Incoming items for preview:', { items });
    const { valid, errors, items: validatedItems } = await Product.validateCartItems(items, country);
    if (!valid) {
      logger.debug('Cart validation failed:', { errors, items });
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

        const isFreeShipping = (validatedItems.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0)) >= 100;

        const flatRates = { 'Standard': 5, 'Expedited': 7, 'Priority': 15 };
        let customerCharge = flatRates[p.shippingSpeedCategory] || 0;
        if (isFreeShipping) customerCharge = 0;
        
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

    // Subtotal check for free shipping
    const subtotal = validatedItems.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
    const isFree = subtotal >= 100;

    // User requested flat rates: Standard $5, Expedited $7, Priority $15
    const allOptions = [
      {
        id: 'standard',
        name: 'Standard Shipping',
        price: isFree ? 0 : 5.00,
        currency: 'USD',
        estimation: getEst('Standard', 'Estimated 3-5 business days'),
        shippingSpeedCategory: 'Standard'
      },
      {
        id: 'expedited',
        name: 'Expedited Shipping',
        price: isFree ? 0 : 7.00,
        currency: 'USD',
        estimation: getEst('Expedited', 'Estimated 2-3 business days'),
        shippingSpeedCategory: 'Expedited'
      },
      {
        id: 'priority',
        name: 'Priority Shipping',
        price: isFree ? 0 : 15.00,
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

    const { valid, errors, items: validatedItems, subtotal } = await Product.validateCartItems(items, country);
    if (!valid) {
      return res.status(400).json({ success: false, message: 'Cart validation failed', errors });
    }

    const totalQty = validatedItems.reduce((sum, item) => sum + (item.quantity || 1), 0);
    const isFree = subtotal >= 100;

    const fixedRate = {
        id: 'standard_ca',
        name: 'Standard Shipping',
        price: isFree ? 0 : parseFloat((totalQty * 10).toFixed(2)),
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
    const { country, state, subtotal, province } = req.body;
    const result = await taxService.calculateTax(subtotal, country, province || state);
    
    return res.json({ 
      success: true, 
      tax: result.amount, 
      tax_label: result.label, 
      rate: result.rate 
    });
  } catch (err) {
    logger.error(`POST /api/fulfillment/calculate-tax error: ${err.message}`);
    return res.json({ success: true, tax: 0, tax_label: 'Tax', rate: 0 });
  }
});

export default router;
