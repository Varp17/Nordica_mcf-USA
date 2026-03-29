import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';

async function backfill() {
  const db = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'root',
    database: 'nordica_ecomsuM'
  });

  try {
    console.log("🚀 Starting FINAL ESM backfill of product_color_variants...");
    const [products] = await db.execute("SELECT id, name, color_options, price FROM products WHERE is_active = 1");

    let totalCreated = 0;

    for (const p of products) {
      if (!p.color_options) continue;

      let colors = [];
      try {
        colors = typeof p.color_options === 'string' ? JSON.parse(p.color_options) : p.color_options;
      } catch (e) { continue; }

      if (!Array.isArray(colors)) continue;

      for (const c of colors) {
        const sku = c.amazon_sku || c.sku || null;
        if (!sku) continue;

        // Check if exists
        const [existing] = await db.execute(
          "SELECT id FROM product_color_variants WHERE product_id = ? AND amazon_sku = ?",
          [p.id, sku]
        );

        if (existing.length === 0) {
          const variantId = uuidv4();
          await db.execute(
            `INSERT INTO product_color_variants (
              id, product_id, variant_name, color_name, color_code, amazon_sku, 
              stock, price, is_active, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
            [
              variantId, 
              p.id, 
              c.name || c.color_name || c.value || "Default", // Set variant_name
              c.name || c.color_name || c.value || "Default", // Set color_name
              c.color || c.color_code || "#CCCCCC", 
              sku,
              parseInt(c.stock) || 0,
              parseFloat(c.price) || parseFloat(p.price) || 0
            ]
          );

          // Also handle image if it exists in JSON
          if (c.image) {
            // Check schema: no created_at, use image_type='color_variant'
            await db.execute(
              "INSERT INTO product_images (id, product_id, color_variant_id, image_url, is_primary, image_type) VALUES (?, ?, ?, ?, 1, ?)",
              [uuidv4(), p.id, variantId, c.image, 'color_variant']
            );
          }
          totalCreated++;
        } else {
          // UPDATE existing to fix "Default" variant_name/color_name issues
          await db.execute(
            `UPDATE product_color_variants SET 
              variant_name = ?, 
              color_name = ?, 
              color_code = ? 
             WHERE id = ?`,
            [
              c.name || c.color_name || c.value || "Default",
              c.name || c.color_name || c.value || "Default",
              c.color || c.color_code || "#CCCCCC",
              existing[0].id
            ]
          );
        }
      }
    }

    console.log(`✅ Final Backfill complete. Created ${totalCreated} variant records.`);
  } catch (err) {
    console.error("❌ Final Backfill failed:", err);
  } finally {
    await db.end();
  }
}

backfill();
