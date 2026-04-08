import db from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * Update product dimensions and weights
 * Run: node scripts/update-product-dimensions.js
 */

const PRODUCT_DIMENSIONS = {
  // Dirt Lock Car Wash Insert
  '12d934c1-2b91-11f1-ac48-767b5e3bd9b8': {
    weight_kg: 0.3,
    dimensions: '25x25x15' // LxWxH in cm
  },
  // Dirt Lock Scrub Wall
  '12d9f202-2b91-11f1-ac48-767b5e3bd9b8': {
    weight_kg: 0.2,
    dimensions: '30x10x5'
  },
  // Dirt Lock Scrub and Pump Attachment
  '12dabe9c-2b91-11f1-ac48-767b5e3bd9b8': {
    weight_kg: 0.15,
    dimensions: '20x15x8'
  },
  // Dirt Lock Pad Washer System
  '12db84ef-2b91-11f1-ac48-767b5e3bd9b8': {
    weight_kg: 0.8,
    dimensions: '35x25x20'
  },
  // Hose Guide
  '12dc4797-2b91-11f1-ac48-767b5e3bd9b8': {
    weight_kg: 0.4,
    dimensions: '40x20x10'
  }
  // Add more products here...
};

async function updateProductDimensions() {
  console.log('🔄 Updating product dimensions and weights...');

  for (const [productId, data] of Object.entries(PRODUCT_DIMENSIONS)) {
    try {
      await db.query(
        'UPDATE products SET weight_kg = ?, dimensions = ? WHERE id = ?',
        [data.weight_kg, data.dimensions, productId]
      );
      console.log(`✅ Updated ${productId}: ${data.weight_kg}kg, ${data.dimensions}cm`);
    } catch (err) {
      console.error(`❌ Failed to update ${productId}:`, err.message);
    }
  }

  console.log('✅ Product dimensions update complete!');
}

updateProductDimensions().catch(console.error);