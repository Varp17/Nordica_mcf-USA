import db from "../config/database.js";

async function run() {
  const [legacySkus] = await db.execute(`
      SELECT 
        pcv.id,
        pcv.product_id,
        p.name as product_name,
        pcv.variant_name,
        pcv.color_name,
        pcv.amazon_sku,
        pcv.sku,
        pcv.stock,
        pcv.price,
        pcv.updated_at,
        p.target_country,
        'legacy' as table_source
      FROM product_color_variants pcv
      JOIN products p ON pcv.product_id = p.id
      WHERE pcv.is_active = 1 AND p.is_active = 1 AND p.target_country = 'canada'
    `);
    
    console.log("Canada Variants in Inventory Source (Legacy Table):", legacySkus.length);
    if (legacySkus.length > 0) {
        console.table(legacySkus.slice(0, 10));
    }
    
    process.exit(0);
}

run();
