import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';

async function backfillVariantImages() {
  const db = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'root',
    database: 'nordica_ecomsuM'
  });

  try {
    console.log("🚀 Backfilling variant images with fuzzy matching...");
    const [products] = await db.execute("SELECT id, color_options FROM products WHERE is_active = 1");

    let totalImages = 0;

    for (const p of products) {
      if (!p.color_options) continue;

      let colors = [];
      try {
        colors = typeof p.color_options === 'string' ? JSON.parse(p.color_options) : p.color_options;
      } catch (e) { continue; }

      if (!Array.isArray(colors)) continue;

      for (const c of colors) {
        if (!c.image) continue;
        const colorName = c.name || c.color_name || c.value || "Default";
        const sku = c.amazon_sku || c.sku || "";

        // Attempt 1: Match by SKU
        let [variants] = await db.execute(
          "SELECT id FROM product_color_variants WHERE product_id = ? AND amazon_sku = ?",
          [p.id, sku]
        );

        // Attempt 2: Match by Color Name (Case Insensitive)
        if (variants.length === 0) {
          [variants] = await db.execute(
            "SELECT id FROM product_color_variants WHERE product_id = ? AND LOWER(color_name) = LOWER(?)",
            [p.id, colorName]
          );
        }

        if (variants.length > 0) {
          const variantId = variants[0].id;

          // Check for existing
          const [existing] = await db.execute(
            "SELECT id FROM product_images WHERE color_variant_id = ? AND image_url = ?",
            [variantId, c.image]
          );

          if (existing.length === 0) {
            await db.execute(
              `INSERT INTO product_images (id, product_id, color_variant_id, image_url, image_type, is_primary)
               VALUES (?, ?, ?, ?, 'color_variant', 1)`,
              [uuidv4(), p.id, variantId, c.image]
            );
            totalImages++;
            console.log(`✅ Added image for ${colorName} (${p.id})`);
          }
        }
      }
    }

    console.log(`✅ Fuzzy image backfill complete. Added ${totalImages} variant images.`);
  } catch (err) {
    console.error("❌ Backfill failed:", err);
  } finally {
    await db.end();
  }
}

backfillVariantImages();
