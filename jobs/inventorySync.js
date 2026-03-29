'use strict';

/**
 * Inventory Sync — Background Job (setInterval-based)
 * ────────────────────────────────────────────────────
 * Periodically polls Amazon SP-API for current stock levels
 * and updates local DB (products.inventory_cache, product_color_variants.stock,
 * and products.color_options JSON).
 *
 * Runs every 1 HOUR as requested.
 * Initial sync runs 10 seconds after server start.
 *
 * NOTE: Previous version used Bull + Redis queues. Replaced with setInterval
 *       for reliability when Redis is unavailable. The old Bull-based code is
 *       preserved in comments at the bottom for reference.
 */

import db from '../config/database.js';
import mcfService from '../services/mcfService.js';
import logger from '../utils/logger.js';
import { setLastSyncedAt } from '../utils/stockSyncState.js';

const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INITIAL_DELAY_MS = 10 * 1000;      // 10 seconds after server start

let _intervalId = null;
let _isSyncing = false;

/**
 * Core sync logic — fetches all inventory from Amazon SP-API
 * and updates the local database.
 */
async function runSync() {
  // Prevent overlapping syncs
  if (_isSyncing) {
    logger.warn('InventorySync: Sync already in progress, skipping this cycle.');
    return { skipped: true };
  }

  _isSyncing = true;
  const startTime = Date.now();

  try {
    logger.info('🔄 InventorySync: Starting Amazon stock synchronization...');

    // 1. Collect all SKUs from US products only (Amazon FBA is US only)
    const [products] = await db.query(
      `SELECT id, name, amazon_sku, color_options FROM products 
       WHERE is_active = 1 AND (country IS NULL OR LOWER(country) IN ('us', 'usa', 'both') OR LOWER(target_country) IN ('us', 'usa', 'both'))`
    );

    const skusToFetch = new Set();
    products.forEach(p => {
      if (p.amazon_sku) skusToFetch.add(p.amazon_sku);
      try {
        const colors = typeof p.color_options === 'string' ? JSON.parse(p.color_options) : p.color_options;
        if (Array.isArray(colors)) {
          colors.forEach(c => {
            if (c.amazon_sku) skusToFetch.add(c.amazon_sku);
          });
        }
      } catch (e) { /* ignore JSON parse errors */ }
    });

    // Also check product_color_variants table
    const [variants] = await db.query(
      `SELECT amazon_sku FROM product_color_variants WHERE amazon_sku IS NOT NULL AND is_active = 1`
    );
    variants.forEach(v => skusToFetch.add(v.amazon_sku));

    const allSkus = Array.from(skusToFetch);

    if (!allSkus.length) {
      logger.info('InventorySync: No active products/variants with Amazon SKUs to sync.');
      _isSyncing = false;
      return { updated: 0 };
    }

    logger.info(`InventorySync: Found ${allSkus.length} local SKUs to sync. Fetching ALL inventory from Amazon SP-API...`);

    // 2. Fetch ALL inventory from SP-API (don't pass specific SKUs — avoids URL encoding issues)
    //    This matches the proven working pattern from view_mcf_stock.js
    let inventory;
    try {
      inventory = await mcfService.listInventory([]);  // Empty = fetch ALL
    } catch (apiErr) {
      // Handle Amazon SP-API auth errors gracefully
      const status = apiErr?.response?.status || (apiErr.message?.includes('401') ? 401 : 0);
      if (status === 401 || status === 403) {
        logger.warn(`⚠️  InventorySync: Amazon SP-API returned ${status} (auth expired). Skipping this cycle. Will retry next hour.`);
        logger.warn(`   → Make sure SP-API refresh token and credentials are valid.`);
      } else {
        logger.error(`❌ InventorySync: Amazon SP-API call failed: ${apiErr.message}`);
      }
      _isSyncing = false;
      return { success: false, error: `SP-API error: ${apiErr.message}` };
    }

    // Build lookup map from ALL Amazon inventory
    const inventoryMap = {};
    inventory.forEach(item => {
      inventoryMap[item.sku] = item.quantity;
    });

    // Count how many of our local SKUs were found on Amazon
    const matchedSkus = allSkus.filter(sku => inventoryMap[sku] !== undefined);
    const unmatchedSkus = allSkus.filter(sku => inventoryMap[sku] === undefined);

    logger.info(`📦 InventorySync: Received ${inventory.length} total inventory items from Amazon.`);
    logger.info(`📦 InventorySync: Matched ${matchedSkus.length}/${allSkus.length} local SKUs to Amazon inventory.`);
    if (unmatchedSkus.length > 0) {
      logger.warn(`⚠️  InventorySync: ${unmatchedSkus.length} SKUs NOT found on Amazon: ${unmatchedSkus.join(', ')}`);
    }

    // 3. Update database
    let updateCount = 0;

    for (const p of products) {
      let totalStock = 0;
      let hasAmazonStock = false;
      let colorsUpdated = false;

      // A. Update color_options JSON within the products table
      try {
        let colors = typeof p.color_options === 'string' ? JSON.parse(p.color_options) : p.color_options;
        if (Array.isArray(colors)) {
          colors = colors.map(c => {
            if (c.amazon_sku && inventoryMap[c.amazon_sku] !== undefined) {
              const q = inventoryMap[c.amazon_sku];
              totalStock += q;
              hasAmazonStock = true;
              if (c.stock !== q) {
                colorsUpdated = true;
              }
              return { ...c, stock: q, in_stock: q > 0 ? 1 : 0 };
            }
            return c;
          });
          if (colorsUpdated) {
            await db.execute('UPDATE products SET color_options = ? WHERE id = ?', [JSON.stringify(colors), p.id]);
            
            // NEW: Update separate product_color_variants table for CRM visibility
            for (const c of colors) {
              if (c.amazon_sku && inventoryMap[c.amazon_sku] !== undefined) {
                await db.execute(
                  'UPDATE product_color_variants SET stock = ?, updated_at = NOW() WHERE amazon_sku = ? AND product_id = ?',
                  [inventoryMap[c.amazon_sku], c.amazon_sku, p.id]
                );
              }
            }
          }
        }
      } catch (e) {
        logger.error(`InventorySync: Error parsing color_options for product ${p.name}: ${e.message}`);
      }

      // B. Update product-level stock if it has a direct amazon_sku
      if (p.amazon_sku && inventoryMap[p.amazon_sku] !== undefined) {
        totalStock = inventoryMap[p.amazon_sku];
        hasAmazonStock = true;
      }

      // C. Write the aggregated stock to products table
      if (hasAmazonStock) {
        const availability = totalStock > 0 ? 'In Stock' : 'Out of Stock';
        const inStock = totalStock > 0 ? 1 : 0;

        const [res] = await db.execute(
          `UPDATE products SET inventory_cache = ?, in_stock = ?, availability = ?, updated_at = NOW() WHERE id = ?`,
          [totalStock, inStock, availability, p.id]
        );
        if (res.affectedRows > 0) updateCount++;
      }
    }

    // D. Update product_color_variants table directly
    for (const item of inventory) {
      const [vResult] = await db.execute(
        `UPDATE product_color_variants SET stock = ?, updated_at = NOW() WHERE amazon_sku = ? AND is_active = 1`,
        [item.quantity, item.sku]
      );
      if (vResult.affectedRows > 0) updateCount++;

      // Also update product_variants table (new standard)
      await db.execute(
        `UPDATE product_variants SET stock = ?, updated_at = NOW() WHERE amazon_sku = ?`,
        [item.quantity, item.sku]
      ).catch(() => { /* product_variants row may not exist for all SKUs */ });
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const syncTimestamp = new Date().toISOString();

    // Update the global last-synced timestamp for the stock API
    setLastSyncedAt(syncTimestamp);

    logger.info(`✅ InventorySync: Complete in ${elapsed}s. Updated ${updateCount} records. SKUs polled: ${allSkus.length}`);

    return { success: true, skusPolled: allSkus.length, updated: updateCount, elapsed, syncTimestamp };

  } catch (err) {
    logger.error(`❌ InventorySync Error: ${err.message}`, { stack: err.stack });
    return { success: false, error: err.message };
  } finally {
    _isSyncing = false;
  }
}

/**
 * Start the periodic inventory sync.
 * Runs once after INITIAL_DELAY_MS, then every SYNC_INTERVAL_MS.
 */
export function startInventorySync() {
  if (_intervalId) {
    logger.warn('InventorySync: Already running, not starting again.');
    return;
  }

  logger.info(`InventorySync: Scheduled — Initial sync in ${INITIAL_DELAY_MS / 1000}s, then every ${SYNC_INTERVAL_MS / 3600000} hour(s).`);

  // Initial sync after short delay (let server boot first)
  setTimeout(() => {
    runSync().catch(err => logger.error(`InventorySync: Initial sync failed: ${err.message}`));
  }, INITIAL_DELAY_MS);

  // Recurring sync
  _intervalId = setInterval(() => {
    runSync().catch(err => logger.error(`InventorySync: Scheduled sync failed: ${err.message}`));
  }, SYNC_INTERVAL_MS);
}

/**
 * Stop the inventory sync job.
 */
export async function stop() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
    logger.info('InventorySync: Stopped.');
  }
}

/**
 * Manually trigger a sync (for admin/debug use).
 */
export { runSync };

export default { startInventorySync, stop, runSync };

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHIVED: Previous Bull/Redis-based implementation (kept for reference)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * import Bull from 'bull';
 *
 * const redisConfig = {
 *   redis: {
 *     host:     process.env.REDIS_HOST     || '127.0.0.1',
 *     port:     parseInt(process.env.REDIS_PORT || '6379'),
 *     username: process.env.REDIS_USER     || 'default',
 *     password: process.env.REDIS_PASSWORD || undefined
 *   }
 * };
 *
 * const inventoryQueue = new Bull('inventory-sync', redisConfig);
 *
 * inventoryQueue.process('sync-all-variants', 1, async (job) => {
 *   // ... (same sync logic as runSync above)
 * });
 *
 * export async function startInventorySync() {
 *   const repeatableJobs = await inventoryQueue.getRepeatableJobs();
 *   for (const job of repeatableJobs) {
 *     await inventoryQueue.removeRepeatableByKey(job.key);
 *   }
 *   await inventoryQueue.add(
 *     'sync-all-variants',
 *     {},
 *     { repeat: { cron: '* /15 * * * *' }, removeOnComplete: 10 }
 *   );
 *   logger.info('InventorySync: Scheduled for every 15 minutes');
 * }
 */
