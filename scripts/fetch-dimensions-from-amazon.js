import 'dotenv/config';
import { getProductDimensionsFromMCF } from '../services/mcfService.js';
import db from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * Fetch product dimensions and weights from Amazon MCF catalog
 * Updates the database with accurate shipping dimensions
 *
 * Run: node scripts/fetch-dimensions-from-amazon.js
 */

async function fetchDimensionsFromAmazon() {
  console.log('🔄 Fetching product dimensions from Amazon MCF (USA-only)...');

  try {
    // 1. Get all US products and their color_options for scanning
    const [products] = await db.query(
      'SELECT id, name, sku, amazon_sku, asin, color_options, weight_kg, dimensions FROM products WHERE target_country IN ("us", "both") AND (hide_for_usa = 0 OR hide_for_usa IS NULL)'
    );
    
    // 2. Get any US variants from product_variants table
    const [variants] = await db.query(
      'SELECT v.id, v.product_id, v.sku, v.amazon_sku, v.asin FROM product_variants v JOIN products p ON v.product_id = p.id WHERE v.amazon_sku IS NOT NULL AND LENGTH(v.amazon_sku) > 0 AND p.target_country IN ("us", "both") AND (p.hide_for_usa = 0 OR p.hide_for_usa IS NULL)'
    );

    console.log(`Found ${products.length} products and ${variants.length} variants in database after USA filtering.`);

    // 3. Collect unique SKUs needing updates, mapping them back to their parent product_id, variant_id (if any), and asin
    const skuMap = new Map(); // amazon_sku -> { productIds: Set, variantIds: Set, asin: string }

    const addSku = (sku, productId, variantId = null, asin = null) => {
      if (!sku || sku.length === 0) return;
      if (!skuMap.has(sku)) {
        skuMap.set(sku, { productIds: new Set(), variantIds: new Set(), asin: asin });
      }
      skuMap.get(sku).productIds.add(productId);
      if (variantId) skuMap.get(sku).variantIds.add(variantId);
      if (asin && !skuMap.get(sku).asin) skuMap.get(sku).asin = asin;
    };

    // Scan top-level product SKUs
    products.forEach(p => {
      // Force refresh if missing Imperial dimensions or if we just want updated data
      if (p.amazon_sku) {
        addSku(p.amazon_sku, p.id, null, p.asin);
      }
      
      // Scan color_options JSON
      if (p.color_options) {
        try {
          let options = p.color_options;
          if (typeof options === 'string') options = JSON.parse(options);
          (options || []).forEach(opt => {
            if (opt.amazon_sku) addSku(opt.amazon_sku, p.id, null, opt.asin);
          });
        } catch (e) {
          logger.error(`Failed to parse color_options for product ${p.id}: ${e.message}`);
        }
      }
    });

    // Scan variants table
    variants.forEach(v => {
      addSku(v.amazon_sku, v.product_id, v.id, v.asin);
    });

    const uniqueSkus = Array.from(skuMap.keys());
    console.log(`🔍 Identified ${uniqueSkus.length} unique Amazon SKUs to verify.`);

    if (uniqueSkus.length === 0) {
      console.log('✅ No SKUs found needing updates (or all already have dimensions and ASIN).');
      return;
    }

    let successCount = 0;
    let errorCount = 0;

    for (const [sku, data] of skuMap.entries()) {
      console.log(`📦 Processing: ${sku} (Current ASIN: ${data.asin || 'none'})`);
      
      try {
        // This function handles LWA refresh, Listings API (sku->asin), and Catalog API
        const result = await getProductDimensionsFromMCF(sku, data.asin);
        
        if (result.weight_kg && result.dimensions) {
          console.log(`✅ Received: ${result.weight_kg}kg (${result.weight_lb}lb), ${result.dimensions} (${result.dimensions_imperial})`);
          
          // 4. Update parent products
          for (const productId of data.productIds) {
            // Update dimensions, weight (both metric and imperial), and also the ASIN if we resolved a new one
            await db.query(
              'UPDATE products SET weight_kg = ?, weight_lb = ?, dimensions = ?, dimensions_imperial = ?, asin = COALESCE(asin, ?) WHERE id = ?',
              [result.weight_kg, result.weight_lb, result.dimensions, result.dimensions_imperial, result.asin || data.asin, productId]
            );
          }

          // 5. Update individual variants (explicitly setting dimensions and resolved ASIN)
          for (const variantId of data.variantIds) {
              await db.query(
                  'UPDATE product_variants SET weight_kg = ?, weight_lb = ?, dimensions = ?, dimensions_imperial = ?, asin = COALESCE(asin, ?) WHERE id = ?',
                  [result.weight_kg, result.weight_lb, result.dimensions, result.dimensions_imperial, result.asin || data.asin, variantId]
              );
          }
          
          console.log(`   Updated records in DB.`);
          successCount++;
        } else {
          console.log(`⚠️ No dimensions found in catalog for ${sku}`);
          errorCount++;
        }

        // Rate limiting - Amazon allows ~1-2 requests per second for Catalog
        await new Promise(resolve => setTimeout(resolve, 1500));

      } catch (err) {
        console.log(`❌ Failed for ${sku}: ${err.message}`);
        errorCount++;
      }
    }

    console.log(`\n✅ Completed: ${successCount} updated, ${errorCount} failed`);
    console.log('📊 Database now has accurate dimensions for USA MCF shipping');

  } catch (err) {
    console.error('❌ Script failed:', err);
    process.exit(1);
  }
}

fetchDimensionsFromAmazon().catch(console.error);