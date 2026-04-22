import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const db = (await import('../config/database.js')).default;
const mcfService = (await import('./mcfService.js')).default;
const logger = (await import('../utils/logger.js')).default;

// Track last successful sync time
export let lastSyncedAt = null;

export async function syncAmazonStock() {
  try {
    logger.info('🔄 Starting comprehensive Amazon MCF stock synchronization...');

    // 1. Fetch ALL inventory from Amazon MCF
    const responseItems = await mcfService.listInventory([]);
    if (!responseItems.length) {
      logger.warn('No inventory found on Amazon MCF.');
      return;
    }
    
    const inventoryMap = {};
    responseItems.forEach(item => {
      inventoryMap[item.sku] = item.quantity;
    });

    logger.info(`📦 Received ${responseItems.length} inventory summaries from Amazon.`);

    // 2. Get all target US/Both products to update
    const [products] = await db.query(
      "SELECT id, name, amazon_sku, color_options FROM products WHERE is_active = 1 AND (LOWER(target_country) = 'us' OR LOWER(target_country) = 'both')"
    );
    
    let updatedProducts = 0;

    for (const p of products) {
      let totalStock = 0;
      let hasAmazonMapping = false;
      let colorsChanged = false;

      // A. Update color_options JSON
      try {
        let colors = p.color_options;
        if (typeof colors === 'string') colors = JSON.parse(colors || '[]');
        
        if (Array.isArray(colors)) {
          colors = colors.map(c => {
            if (c.amazon_sku) {
              const q = inventoryMap[c.amazon_sku] || 0;
              totalStock += q;
              hasAmazonMapping = true;
              if (c.stock !== q) {
                colorsChanged = true;
                return { ...c, stock: q, in_stock: q > 0 ? 1 : 0, updated_at: new Date().toISOString() };
              }
            }
            return c;
          });
          
          if (colorsChanged) {
            await db.execute('UPDATE products SET color_options = ? WHERE id = ?', [JSON.stringify(colors), p.id]);
          }
        }
      } catch (e) {
        logger.error(`Error parsing colors for ${p.name}: ${e.message}`);
      }

      // B. Update product-level stock (if primary amazon_sku matches)
      if (p.amazon_sku) {
        totalStock = inventoryMap[p.amazon_sku] || 0;
        hasAmazonMapping = true;
      }

      // C. If NO explicit amazon_sku on product but we found variants with stock, use that total
      if (hasAmazonMapping) {
        // Sync main stock fields
        const availability = totalStock > 0 ? 'In Stock' : 'Out of Stock';
        const inStock = totalStock > 0 ? 1 : 0;
        
        logger.info(`Updating DB for ${p.name}: Stock=${totalStock}, InStock=${inStock}`);

        await db.execute(
          `UPDATE products SET inventory_cache = ?, in_stock = ?, availability = ? WHERE id = ?`,
          [totalStock, inStock, availability, p.id]
        );
        updatedProducts++;
      }
    }

    // D. Also update product_color_variants table for each SKU directly
    for (const [sku, qty] of Object.entries(inventoryMap)) {
      await db.execute(
        `UPDATE product_color_variants SET stock = ?, updated_at = NOW() WHERE amazon_sku = ? AND is_active = 1`,
        [qty, sku]
      ).catch(() => { /* variant row may not exist */ });
    }

    // Track sync timestamp
    lastSyncedAt = new Date().toISOString();

    // Update stock route's last sync timestamp if available
    try {
      const { setLastSyncedAt } = await import('../utils/stockSyncState.js');
      setLastSyncedAt(lastSyncedAt);
    } catch (e) { /* stock route may not be loaded in standalone mode */ }

    logger.info(`✅ Sync complete. Successfully updated stock for ${updatedProducts} products.`);
    return { success: true, count: updatedProducts, lastSyncedAt };

  } catch (error) {
    logger.error('❌ Amazon stock sync failed:', error);
    throw error;
  }
}

if (process.argv[1].includes('syncStock.js')) {
  syncAmazonStock().then(() => process.exit(0)).catch(() => process.exit(1));
}
