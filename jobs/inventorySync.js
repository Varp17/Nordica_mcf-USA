'use strict';

/**
 * Inventory Sync — Background Job
 * ──────────────────────────────
 * Periodically polls Amazon SP-API for current stock levels 
 * and updates local `inventory_cache` in `product_variants`.
 */

// const Bull         = require('bull');
// const db           = require('../config/database');
// const mcfService   = require('../services/mcfService');
// const logger       = require('../utils/logger');

import Bull from 'bull';
import db from '../config/database.js';
import mcfService from '../services/mcfService.js';
import logger from '../utils/logger.js';


const redisConfig = {
  redis: {
    host:     process.env.REDIS_HOST     || '127.0.0.1',
    port:     parseInt(process.env.REDIS_PORT || '6379'),
    username: process.env.REDIS_USER     || 'default',
    password: process.env.REDIS_PASSWORD || undefined
  }
};

const inventoryQueue = new Bull('inventory-sync', redisConfig);

// ── Process: Bulk Inventory Sync ─────────────────────────────────────────────
inventoryQueue.process('sync-all-variants', 1, async (job) => {
  logger.info('InventorySync: Starting bulk stock update...');

  try {
    // 1. Get all variants that have an amazon_sku
    const [variants] = await db.query(
      `SELECT amazon_sku FROM product_variants WHERE amazon_sku IS NOT NULL AND is_active = 1`
    );

    if (!variants.length) {
      logger.info('InventorySync: No active variants with SKUs to sync');
      return { updated: 0 };
    }

    const skus = variants.map(v => v.amazon_sku);
    logger.info(`InventorySync: Fetching stock for ${skus.length} SKUs from Amazon`);

    // 2. Fetch inventory summaries from SP-API
    const inventory = await mcfService.listInventory(skus);

    // 3. Update DB
    let updateCount = 0;
    for (const item of inventory) {
      const [result] = await db.query(
        `UPDATE product_variants SET stock = ?, updated_at = NOW() WHERE amazon_sku = ?`,
        [item.quantity, item.sku]
      );
      if (result.affectedRows > 0) updateCount++;
    }

    logger.info(`InventorySync: Complete. Updated ${updateCount} variants.`);
    return { skusPolled: skus.length, updated: updateCount };

  } catch (err) {
    logger.error(`InventorySync Error: ${err.message}`);
    throw err;
  }
});

export async function startInventorySync() {
  const repeatableJobs = await inventoryQueue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    await inventoryQueue.removeRepeatableByKey(job.key);
  }

  await inventoryQueue.add(
    'sync-all-variants',
    {},
    { repeat: { cron: '*/15 * * * *' }, removeOnComplete: 10 }
  );

  logger.info('InventorySync: Scheduled for every 15 minutes');
}

export async function stop() {
  await inventoryQueue.close();
  logger.info('InventorySync: Queue closed');
}

export default { startInventorySync, inventoryQueue, stop };
