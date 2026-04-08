import db from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * Update products with Amazon SKU values
 * Replace the placeholder SKUs below with your actual Amazon MCF SKUs
 *
 * Run: node scripts/update-amazon-skus.js
 */

const AMAZON_SKUS = {
  // Map your product IDs to their Amazon MCF SKUs
  '12d934c1-2b91-11f1-ac48-767b5e3bd9b8': 'DIRT-LOCK-INSERT',     // Dirt Lock Car Wash Insert
  '12d9f202-2b91-11f1-ac48-767b5e3bd9b8': 'DIRT-LOCK-SCRUB-WALL', // Dirt Lock Scrub Wall
  '12dabe9c-2b91-11f1-ac48-767b5e3bd9b8': 'DIRT-LOCK-ATTACHMENT',  // Dirt Lock Scrub and Pump Attachment
  '12db84ef-2b91-11f1-ac48-767b5e3bd9b8': 'DIRT-LOCK-PAD-WASHER',  // Dirt Lock Pad Washer System
  '12dc4797-2b91-11f1-ac48-767b5e3bd9b8': 'DIRT-LOCK-HOSE-GUIDE'   // Hose Guide
  // Add more mappings here...
};

async function updateAmazonSkus() {
  console.log('🔄 Updating products with Amazon MCF SKUs...');

  let successCount = 0;
  let errorCount = 0;

  for (const [productId, amazonSku] of Object.entries(AMAZON_SKUS)) {
    try {
      const [result] = await db.query(
        'UPDATE products SET amazon_sku = ?, updated_at = NOW() WHERE id = ?',
        [amazonSku, productId]
      );

      if (result.affectedRows > 0) {
        console.log(`✅ Updated ${productId} with SKU: ${amazonSku}`);
        successCount++;
      } else {
        console.log(`⚠️  Product ${productId} not found`);
        errorCount++;
      }

    } catch (err) {
      console.error(`❌ Failed to update ${productId}:`, err.message);
      errorCount++;
    }
  }

  console.log(`\n✅ Completed: ${successCount} updated, ${errorCount} failed`);
  console.log('📝 Next: Run "node scripts/fetch-dimensions-from-amazon.js" to get dimensions from MCF');
}

updateAmazonSkus().catch(console.error);