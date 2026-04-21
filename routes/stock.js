/**
 * Stock API — Public Endpoint
 * ────────────────────────────
 * GET /api/stock?skus=SKU1,SKU2,...
 *
 * Returns real-time stock levels from the LOCAL DATABASE (not Amazon live).
 * Stock is periodically synced from Amazon SP-API every 1 hour by inventorySync.
 *
 * ⚠️  This endpoint is PUBLIC — no auth required.
 *     Works for all users: guests, logged-in customers, admins.
 *
 * Response shape:
 *   { "SKU1": { quantity: 10, inStock: true, lastSyncedAt: "..." }, ... }
 */

import express from 'express';
import db from '../config/database.js';
import logger from '../utils/logger.js';
import { getLastSyncedAt } from '../utils/stockSyncState.js';

const router = express.Router();

/**
 * GET /api/stock?skus=SKU1,SKU2,...
 *
 * Batch stock lookup. Max 50 SKUs per request to prevent abuse.
 */
router.get('/', async (req, res) => {
  try {
    const skusParam = req.query.skus;

    if (!skusParam || typeof skusParam !== 'string' || skusParam.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Missing required query parameter: skus (comma-separated list of Amazon SKUs)'
      });
    }

    // Parse and sanitize SKUs
    const skus = skusParam
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 50); // Hard cap at 50 to prevent abuse

    if (skus.length === 0) {
      return res.json({});
    }

    const lastSynced = getLastSyncedAt();
    const result = {};

    // 1. Look up in product_color_variants (primary source for variant-level stock)
    try {
      const variantPlaceholders = skus.map(() => '?').join(',');
      const [variantRows] = await db.execute(
        `SELECT sku, amazon_sku, canada_sku, stock, updated_at 
         FROM product_color_variants 
         WHERE (amazon_sku IN (${variantPlaceholders}) OR sku IN (${variantPlaceholders}) OR canada_sku IN (${variantPlaceholders})) 
         AND is_active = 1`,
        [...skus, ...skus, ...skus]
      );

      for (const row of variantRows) {
        const qty = parseInt(row.stock, 10) || 0;
        const matchedSku = skus.find(s => s === row.amazon_sku || s === row.sku || s === row.canada_sku);
        if (matchedSku) {
          result[matchedSku] = {
            quantity: qty,
            inStock: qty > 0,
            lastSyncedAt: lastSynced || row.updated_at || null
          };
        }
      }
    } catch (dbErr) {
      logger.warn(`Stock route: product_color_variants query failed: ${dbErr.message}`);
    }

    // 1.5. Look up in product_variants (modern table)
    const missingSkusVariants = skus.filter(sku => !result[sku]);
    if (missingSkusVariants.length > 0) {
      try {
        const pvPlaceholders = missingSkusVariants.map(() => '?').join(',');
        const [pvRows] = await db.execute(
          `SELECT sku, amazon_sku, canada_sku, stock, updated_at 
           FROM product_variants 
           WHERE (amazon_sku IN (${pvPlaceholders}) OR sku IN (${pvPlaceholders}) OR canada_sku IN (${pvPlaceholders})) 
           AND is_active = 1`,
          [...missingSkusVariants, ...missingSkusVariants, ...missingSkusVariants]
        );

        for (const row of pvRows) {
          const qty = parseInt(row.stock, 10) || 0;
          const matchedSku = missingSkusVariants.find(s => s === row.amazon_sku || s === row.sku || s === row.canada_sku);
          if (matchedSku) {
            result[matchedSku] = {
              quantity: qty,
              inStock: qty > 0,
              lastSyncedAt: lastSynced || row.updated_at || null
            };
          }
        }
      } catch (dbErr) {
        logger.warn(`Stock route: product_variants query failed: ${dbErr.message}`);
      }
    }

    // 2. For SKUs not found in variants, check products table (amazon_sku field)
    const missingSkus = skus.filter(sku => !result[sku]);
    if (missingSkus.length > 0) {
      try {
        const productPlaceholders = missingSkus.map(() => '?').join(',');
        const [productRows] = await db.execute(
          `SELECT sku, amazon_sku, canada_sku, inventory_cache, in_stock, availability, updated_at
           FROM products 
           WHERE (amazon_sku IN (${productPlaceholders}) OR sku IN (${productPlaceholders}) OR canada_sku IN (${productPlaceholders}))
           AND is_active = 1`,
          [...missingSkus, ...missingSkus, ...missingSkus]
        );

        for (const row of productRows) {
          const qty = parseInt(row.inventory_cache, 10) || 0;
          const matchedSku = missingSkus.find(s => s === row.amazon_sku || s === row.sku || s === row.canada_sku);
          if (matchedSku) {
            result[matchedSku] = {
              quantity: qty,
              inStock: qty > 0,
              lastSyncedAt: lastSynced || row.updated_at || null
            };
          }
        }
      } catch (dbErr) {
        logger.warn(`Stock route: products query failed: ${dbErr.message}`);
      }
    }

    // 3. For SKUs not found in variants OR products, look in color_options JSON
    const stillMissing = skus.filter(sku => !result[sku]);
    if (stillMissing.length > 0) {
      try {
        const [allProducts] = await db.execute(
          `SELECT color_options FROM products WHERE is_active = 1 AND color_options IS NOT NULL`
        );

        for (const p of allProducts) {
          try {
            const colors = typeof p.color_options === 'string'
              ? JSON.parse(p.color_options)
              : p.color_options;

            if (Array.isArray(colors)) {
              for (const c of colors) {
                const variantSku = c.amazon_sku || c.sku || c.id;
                if (variantSku && stillMissing.includes(variantSku) && !result[variantSku]) {
                  const qty = parseInt(c.stock, 10) || 0;
                  result[variantSku] = {
                    quantity: qty,
                    inStock: qty > 0,
                    lastSyncedAt: lastSynced || null
                  };
                }
              }
            }
          } catch (e) {
            // JSON parse error — skip this product
          }
        }
      } catch (dbErr) {
        logger.warn(`Stock route: color_options query failed: ${dbErr.message}`);
      }
    }

    // 4. Any SKUs still not found → return as unknown (quantity null)
    for (const sku of skus) {
      if (!result[sku]) {
        result[sku] = {
          quantity: null,
          inStock: null,
          lastSyncedAt: null
        };
      }
    }

    // Set cache headers — stock data can be cached for 60 seconds
    res.set('Cache-Control', 'public, max-age=60, s-maxage=120');
    return res.json(result);

  } catch (error) {
    logger.error(`Stock API error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch stock data'
    });
  }
});

/**
 * GET /api/stock/sync-status
 * 
 * Returns the last sync timestamp and status.
 * Useful for admin/debug to verify sync is running.
 */
router.get('/sync-status', async (req, res) => {
  const lastSynced = getLastSyncedAt();
  res.json({
    success: true,
    lastSyncedAt: lastSynced,
    syncIntervalHours: 1,
    message: lastSynced
      ? `Last synced at ${new Date(lastSynced).toISOString()}`
      : 'No sync has run yet since server start'
  });
});

/**
 * POST /api/stock/notify
 * 
 * Register a user for stock notifications.
 */
router.post('/notify', async (req, res) => {
  try {
    const { email, product_id, variant_id } = req.body;

    if (!email || !product_id) {
      return res.status(400).json({
        success: false,
        message: 'Email and product_id are required'
      });
    }

    // Check if already registered
    const [existing] = await db.execute(
      `SELECT id FROM stock_notifications 
       WHERE email = ? AND product_id = ? AND (variant_id = ? OR (variant_id IS NULL AND ? IS NULL)) AND notified_at IS NULL`,
      [email, product_id, variant_id || null, variant_id || null]
    );

    if (existing.length > 0) {
      return res.json({
        success: true,
        message: 'You are already registered for notifications on this item.'
      });
    }

    // Insert new registration
    await db.execute(
      `INSERT INTO stock_notifications (product_id, variant_id, email) VALUES (?, ?, ?)`,
      [product_id, variant_id || null, email]
    );

    return res.status(201).json({
      success: true,
      message: 'Notification registered successfully. We will email you when it is back in stock!'
    });

  } catch (error) {
    logger.error(`Stock notify error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: 'Failed to register notification'
    });
  }
});

export default router;
