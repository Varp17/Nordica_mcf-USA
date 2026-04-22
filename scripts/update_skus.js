import db from '../config/database.js';
import logger from '../utils/logger.js';

const SKU_TABLE = [
  { sku: '1008-4-stickerless', fnsku: 'B07ND5F6N8', asin: 'B07ND5F6N8', name: 'DETAIL GUARDZ Car Hose Guides (4 PACK BLACK)' },
  { sku: 'DIRT LOCK-SW180 BLACK', fnsku: 'B09CRZD82Q', asin: 'B09CRZD82Q', name: 'DETAIL GUARDZ Dirt Lock Scrub Wall 180/360 Degree System Attachment for Car Wash Bucket Filter (Black)' },
  { sku: 'DLRP-RED-2-stickerless', fnsku: 'B07CKG1VCH', asin: 'B07CKG1VCH', name: 'DETAIL GUARDZ Dirt Lock Car Wash Insert ? Bucket Filter for 3?8 Gallon Round Pails ? Traps Debris, Prevents Swirl Marks (Red)' },
  { sku: 'DIRT LOCK-SW180 WHITE', fnsku: 'B09CS4P7G3', asin: 'B09CS4P7G3', name: 'DETAIL GUARDZ Dirt Lock Scrub Wall 180/360 Degree System Attachment for Car Wash Bucket Filter (White)' },
  { sku: 'DIRT LOCK-PWSW-H', fnsku: 'B09G964HSR', asin: 'B09G964HSR', name: 'DETAIL GUARDZ The Dirt Lock Pad Washer System Attachment with Spray Cleaner (White)' },
  { sku: 'DIRT LOCK-SW180 RED', fnsku: 'B09CS2Y985', asin: 'B09CS2Y985', name: 'DETAIL GUARDZ Dirt Lock Scrub Wall 180/360 Degree System Attachment for Car Wash Bucket Filter (Red)' },
  { sku: 'DIRT LOCK-SAP BLACK', fnsku: 'B09CRK3YBS', asin: 'B09CRK3YBS', name: 'DETAIL GUARDZ The Dirt Lock Scrub and Pump Attachment for Car Wash Bucket Filter (Black)' },
  { sku: 'Detail Guardz Hose Guides 2.0_Red', fnsku: 'B0CMY8ZJ1L', asin: 'B0CMY8ZJ1L', name: 'DETAIL GUARDZ Hose Guide ? Tire Wheel Rolling System Preventing Stucking and Snagging Under Tires (Red)' },
  { sku: 'Detail Guardz Hose Guides 2.0_NewBlack', fnsku: 'B0CMY8947K', asin: 'B0CMY8947K', name: 'DETAIL GUARDZ Hose Guide ? Tire Wheel Rolling System Preventing Stucking and Snagging Under Tires (Black)' },
  { sku: 'Detail Guardz Hose Guide 2.0_Blue', fnsku: 'B0CMY714TM', asin: 'B0CMY714TM', name: 'DETAIL GUARDZ Hose Guide ? Tire Wheel Rolling System Preventing Stucking and Snagging Under Tires (Blue)' },
  { sku: 'DLRP-5stickers', fnsku: 'B07P9CWKLJ', asin: 'B07P9CWKLJ', name: 'DETAIL GUARDZ Dirt Lock Car Wash Insert ? Bucket Filter for 3?8 Gallon Round Pails ? Traps Debris, Prevents Swirl Marks (Yellow)' },
  { sku: 'DIRT LOCK-PWSW-WHITE-1', fnsku: 'B09G93QYCH', asin: 'B09G93QYCH', name: 'DETAIL GUARDZ Dirt Lock Pad Washer System Attachment (White)' },
  { sku: 'DLRP-WHITE', fnsku: 'B088PZXQY1', asin: 'B088PZXQY1', name: 'DETAIL GUARDZ Dirt Lock Car Wash Insert ? Bucket Filter for 3?8 Gallon Round Pails ? Traps Debris, Prevents Swirl Marks (White)' },
  { sku: '1008-', fnsku: 'B07MVDY96Y', asin: 'B07MVDY96Y', name: 'DETAIL GUARDZ Car Hose Guides (2 Pack Black)' },
  { sku: 'Detail guardz Hose Guides 2.0_Neon', fnsku: 'B0CMY7X8XQ', asin: 'B0CMY7X8XQ', name: 'DETAIL GUARDZ Hose Guide ? Tire Wheel Rolling System Preventing Stucking and Snagging Under Tires (Neon)' },
  { sku: 'DLRP-BLUE-3-stickerless', fnsku: 'B07CKLPJZR', asin: 'B07CKLPJZR', name: 'DETAIL GUARDZ Dirt Lock Car Wash Insert ? Bucket Filter for 3?8 Gallon Round Pails ? Traps Debris, Prevents Swirl Marks (Blue)' },
  { sku: 'DIRT LOCK-SAP WHITE', fnsku: 'B09CS4Q6K4', asin: 'B09CS4Q6K4', name: 'DETAIL GUARDZ The Dirt Lock Scrub and Pump Attachment for Car Wash Bucket Filter (White)' },
  { sku: 'Detail Guardz Hose Guides 2.0_Yellow', fnsku: 'B0CMY8G7Q5', asin: 'B0CMY8G7Q5', name: 'DETAIL GUARDZ Hose Guide ? Tire Wheel Rolling System Preventing Stucking and Snagging Under Tires (Yellow)' },
  { sku: 'DIRT LOCK-PWSBL', fnsku: 'B09G98Y2Y7', asin: 'B09G98Y2Y7', name: 'The Detail Guardz ? Dirt Lock Pad Washer System Attachment with Spray Cleaner (Black)' },
  { sku: 'DIRT LOCK-PWS-BLACK', fnsku: 'B09G94RP6X', asin: 'B09G94RP6X', name: 'The DETAIL GUARDZ ? Dirt Lock Pad Washer System Attachment (Black)' },
  { sku: 'DETAIL GUARDZ-4 BLACK-stickerless-NEW', fnsku: 'B07CKC4M9D', asin: 'B07CKC4M9D', name: 'DETAIL GUARDZ Car Hose Guides (4 PACK BLACK) NEW' },
  { sku: 'DLRP-BLACK-1stickers', fnsku: 'B07CKC4M9D', asin: 'B07CKC4M9D', name: 'DETAIL GUARDZ Dirt Lock Car Wash Insert ? Bucket Filter for 3?8 Gallon Round Pails ? Traps Debris, Prevents Swirl Marks (Black)' }
];

async function updateSkus() {
  console.log('🔄 Starting SKU and Metadata Synchronization...');

  // 1. Map to find the correct products in DB
  const [products] = await db.query('SELECT id, name, color_options FROM products');
  
  let totalUpdated = 0;

  for (const item of SKU_TABLE) {
    try {
      // Find matching product or variant
      // Strategy: Try to match by name or existing amazon_sku
      
      // A. Check product_color_variants
      const [variants] = await db.query(
        `SELECT id, product_id, color_name FROM product_color_variants 
         WHERE amazon_sku = ? OR color_name LIKE ?`,
        [item.sku, `%${item.name.split('(').pop().replace(')', '')}%`]
      );

      if (variants.length > 0) {
        for (const v of variants) {
          await db.execute(
            `UPDATE product_color_variants SET amazon_sku = ?, asin = ?, fnsku = ?, updated_at = NOW() WHERE id = ?`,
            [item.sku, item.asin, item.fnsku, v.id]
          );
          console.log(`✅ Updated Variant: ${v.color_name} for SKU: ${item.sku}`);
          totalUpdated++;
        }
      }

      // B. Update color_options JSON in products table
      for (const p of products) {
        if (!p.color_options) continue;
        let colors = typeof p.color_options === 'string' ? JSON.parse(p.color_options) : p.color_options;
        if (!Array.isArray(colors)) continue;

        let changed = false;
        colors = colors.map(c => {
          // Fuzzy match on color name or SKU
          const colorMatch = item.name.toLowerCase().includes(c.name.toLowerCase()) || 
                             item.name.toLowerCase().includes(c.value?.toLowerCase());
          
          if (c.amazon_sku === item.sku || (colorMatch && p.name.toLowerCase().includes('dirt lock'))) {
            changed = true;
            return { 
              ...c, 
              amazon_sku: item.sku, 
              sku: `USA-${item.sku}`, // Standardize internal SKU
              asin: item.asin,
              fnsku: item.fnsku,
              name: item.name.includes('(') ? item.name.split('(').pop().replace(')', '') : c.name
            };
          }
          return c;
        });

        if (changed) {
          await db.execute('UPDATE products SET color_options = ?, updated_at = NOW() WHERE id = ?', [JSON.stringify(colors), p.id]);
          console.log(`✅ Updated color_options for Product: ${p.name}`);
        }
      }

      // C. Update direct product amazon_sku (for simple products)
      const [res] = await db.execute(
        `UPDATE products SET amazon_sku = ?, updated_at = NOW() 
         WHERE name LIKE ? AND amazon_sku IS NOT NULL`,
        [item.sku, `%${item.name.substring(0, 20)}%`]
      );
      if (res.affectedRows > 0) {
        console.log(`✅ Updated Product Direct SKU: ${item.sku}`);
        totalUpdated++;
      }

    } catch (err) {
      console.error(`❌ Error updating item ${item.sku}: ${err.message}`);
    }
  }

  console.log(`\n🎉 Completed! Total records affected: ${totalUpdated}`);
  process.exit(0);
}

updateSkus().catch(err => {
  console.error(err);
  process.exit(1);
});
