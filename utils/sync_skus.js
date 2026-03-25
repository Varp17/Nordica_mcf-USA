'use strict';

/**
 * SKU Sync Utility
 * ────────────────
 * This script allows you to map your website's internal database products 
 * to your Amazon Seller Central SKUs. 
 * 
 * WHY IS THIS IMPORTANT?
 * Amazon MCF requires an EXACT match of the "SellerSKU" field to fulfill orders.
 * If your database has "DirtLockWall" but Amazon has "DG-SCRUB-180", 
 * the fulfillment will fail.
 * 
 * USAGE:
 * 1. Update the MAPPINGS object below.
 * 2. Run: node sync_skus.js
 */

const db = require('./config/database');
require('dotenv').config();

// KEY: Database ID or Product Name
// VALUE: The actual SellerSKU used in Amazon Seller Central
const MAPPINGS = {
  // Example for Detail Guardz Dirt Lock Scrub Wall
  'B09CRX2D31': 'DG-SCRUB-180',

  // Add other products here...
  // 'PRODUCT_ID_OR_OLD_SKU': 'NEW_AMAZON_SKU'
};

async function syncSkus() {
  console.log('🚀 Starting SKU Synchronization...');

  try {
    for (const [id, amazonSku] of Object.entries(MAPPINGS)) {
      // Find the product by ID first, then fallback to old SKU mapping
      console.log(`Checking mapping for: ${id} -> ${amazonSku}`);

      const [result] = await db.query(
        'UPDATE products SET sku = ? WHERE id = ? OR sku = ?',
        [amazonSku, id, id]
      );

      if (result.affectedRows > 0) {
        console.log(`✅ Success: Updated ${result.affectedRows} record(s) to SKU: ${amazonSku}`);
      } else {
        console.warn(`⚠️ Warning: No product found matching "${id}". Check your database.`);
      }
    }

    console.log('\n✨ SKU Sync Complete. Your database is now aligned with Amazon MCF.');
    process.exit(0);

  } catch (err) {
    console.error('❌ Error during SKU sync:', err.message);
    process.exit(1);
  }
}

// Ensure the DB connection is ready
db.getConnection()
  .then(() => syncSkus())
  .catch(err => {
    console.error('❌ Could not connect to database:', err.message);
    process.exit(1);
  });
