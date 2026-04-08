import { spApiRequest } from '../services/spApiClient.js';
import db from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * Sync product dimensions to Amazon MCF via Listings API
 * This updates the product catalog in Amazon with accurate dimensions
 *
 * IMPORTANT: This requires the products to already be listed on Amazon
 * and you need the correct permissions for the Listings API
 *
 * Run: node scripts/sync-dimensions-to-amazon.js
 */

const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID_US || 'ATVPDKIKX0DER';

async function syncProductDimensionsToAmazon() {
  console.log('🔄 Syncing product dimensions to Amazon MCF...');

  try {
    // Get all products with dimensions and Amazon SKUs
    const [products] = await db.query(`
      SELECT id, name, sku, amazon_sku, weight_kg, dimensions
      FROM products
      WHERE weight_kg IS NOT NULL
        AND dimensions IS NOT NULL
        AND amazon_sku IS NOT NULL
        AND LENGTH(amazon_sku) > 0
    `);

    console.log(`Found ${products.length} products with dimensions to sync`);

    if (products.length === 0) {
      console.log('❌ No products found with dimensions and Amazon SKUs. Run update-product-dimensions.js first.');
      return;
    }

    for (const product of products) {
      try {
        console.log(`📦 Processing ${product.amazon_sku}: ${product.name}`);

        // Parse dimensions (format: "LxWxH" in cm)
        const dims = product.dimensions.split('x').map(d => parseFloat(d.trim()));
        if (dims.length !== 3 || dims.some(d => isNaN(d))) {
          console.error(`❌ Invalid dimensions format for ${product.amazon_sku}: ${product.dimensions}`);
          continue;
        }

        const [length, width, height] = dims;

        // Prepare the patch payload for Amazon Listings API
        const patchPayload = [
          {
            op: "replace",
            path: "/attributes/item_dimensions",
            value: {
              length: { value: length, unit: "centimeters" },
              width: { value: width, unit: "centimeters" },
              height: { value: height, unit: "centimeters" }
            }
          },
          {
            op: "replace",
            path: "/attributes/item_weight",
            value: {
              value: product.weight_kg,
              unit: "kilograms"
            }
          }
        ];

        // Update the listing using Amazon's Listings API
        const response = await spApiRequest(
          'PATCH',
          `/listings/2021-08-01/items/${encodeURIComponent(product.amazon_sku)}`,
          {
            marketplaceIds: [MARKETPLACE_ID],
            patches: patchPayload
          }
        );

        console.log(`✅ Updated ${product.amazon_sku}: ${length}x${width}x${height}cm, ${product.weight_kg}kg`);

        // Add a small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (err) {
        console.error(`❌ Failed to update ${product.amazon_sku}:`, err.message);

        // Continue with other products
        continue;
      }
    }

    console.log('✅ Product dimensions sync completed');
    console.log('⏰ Note: Amazon may take 15-30 minutes to process dimension updates');

  } catch (err) {
    console.error('❌ Sync failed:', err);
    process.exit(1);
  }
}

syncProductDimensionsToAmazon().catch(console.error);