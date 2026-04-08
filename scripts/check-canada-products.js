
import db from '../config/database.js';

async function check() {
  try {
    const [products] = await db.query("SELECT id, name, sku, amazon_sku, country FROM products WHERE country = 'CAD' OR country = 'CA'");
    console.log(`Found ${products.length} Canada products.`);
    for (const p of products) {
      console.log(`Product: ${p.name} (ID: ${p.id}), SKU: ${p.sku}, Amazon SKU: ${p.amazon_sku}`);
      
      const [variants] = await db.query("SELECT id, variant_name, sku, amazon_sku FROM product_variants WHERE product_id = ?", [p.id]);
      if (variants.length > 0) {
        console.log(`  Variants:`);
        for (const v of variants) {
          console.log(`    - ${v.variant_name} (ID: ${v.id}), SKU: ${v.sku}, Amazon SKU: ${v.amazon_sku}`);
        }
      }

      const [legacyVariants] = await db.query("SELECT id, color_name, amazon_sku FROM product_color_variants WHERE product_id = ?", [p.id]);
      if (legacyVariants.length > 0) {
        console.log(`  Legacy Variants:`);
        for (const v of legacyVariants) {
          console.log(`    - ${v.color_name} (ID: ${v.id}), Amazon SKU: ${v.amazon_sku}`);
        }
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}

check();
