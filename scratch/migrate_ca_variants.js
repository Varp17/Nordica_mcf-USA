import db from "../config/database.js";
import { v4 as uuidv4 } from "uuid";

async function run() {
  const [caProducts] = await db.execute("SELECT id, name, target_country, price, color_options FROM products WHERE target_country = 'canada'");
  
  for (const p of caProducts) {
    if (!p.color_options) continue;
    
    let colors = [];
    try {
      colors = typeof p.color_options === 'string' ? JSON.parse(p.color_options) : p.color_options;
    } catch (e) {
      console.error("Failed to parse color options for", p.name);
      continue;
    }
    
    if (!Array.isArray(colors)) continue;
    
    for (const c of colors) {
      const colorName = c.name || c.color_name || c.value;
      if (!colorName) continue;
      
      // Check if it already exists
      const [existing] = await db.execute("SELECT id FROM product_color_variants WHERE product_id = ? AND color_name = ?", [p.id, colorName]);
      
      let variantId;
      if (existing.length === 0) {
        variantId = uuidv4();
        const price = c.price || p.price;
        const stock = c.stock || c.in_stock || 0;
        const sku = c.sku || null;
        
        await db.execute(
          "INSERT INTO product_color_variants (id, product_id, sku, color_name, color, color_code, target_country, price, stock, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())",
          [variantId, p.id, sku, colorName, c.value || colorName, c.color_code || '#000000', 'canada', price, stock]
        );
        console.log(`Inserted variant ${colorName} for product ${p.name}`);
      } else {
        variantId = existing[0].id;
        console.log(`Variant ${colorName} already exists for product ${p.name}`);
      }
      
      // Also sync images if present
      if (c.image) {
        const [imgExisting] = await db.execute("SELECT id FROM product_images WHERE color_variant_id = ? AND image_url = ?", [variantId, c.image]);
        if (imgExisting.length === 0) {
          const imgId = uuidv4();
          await db.execute(
            "INSERT INTO product_images (id, product_id, color_variant_id, image_url, image_type, is_primary) VALUES (?, ?, ?, ?, 'color_variant', 1)",
            [imgId, p.id, variantId, c.image]
          );
          console.log(`Inserted image for variant ${colorName}`);
        }
      }
    }
  }
  process.exit(0);
}

run();
