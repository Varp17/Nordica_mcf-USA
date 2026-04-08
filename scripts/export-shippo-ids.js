
import db from '../config/database.js';

async function exportIds() {
  try {
    const [products] = await db.query("SELECT id, name, sku FROM products WHERE country IN ('CAD', 'CA')");
    const exportList = [];

    for (const p of products) {
      exportList.push({
        Type: 'Product',
        Name: p.name,
        Merchant_ID: p.id,
        Shippo_SKU: p.sku
      });

      // Variants
      const [variants] = await db.query("SELECT id, variant_name, sku FROM product_variants WHERE product_id = ?", [p.id]);
      for (const v of variants) {
        exportList.push({
          Type: 'Variant',
          Name: `${p.name} - ${v.variant_name}`,
          Merchant_ID: v.id,
          Shippo_SKU: v.sku
        });
      }

      // Legacy Variants
      const [legacyVariants] = await db.query("SELECT id, color_name, amazon_sku FROM product_color_variants WHERE product_id = ?", [p.id]);
      for (const v of legacyVariants) {
        exportList.push({
          Type: 'Legacy Variant',
          Name: `${p.name} (${v.color_name})`,
          Merchant_ID: v.id,
          Shippo_SKU: v.amazon_sku
        });
      }
    }

    console.log(JSON.stringify(exportList, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}

exportIds();
