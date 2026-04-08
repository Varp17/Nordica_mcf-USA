
import db from '../config/database.js';
import { v4 as uuidv4 } from 'uuid';

async function update() {
  try {
    const [products] = await db.query("SELECT id, name, sku, amazon_sku FROM products WHERE country IN ('CAD', 'CA')");
    console.log(`Processing ${products.length} Canada products...`);

    const clientList = [];

    for (const p of products) {
      let mainSku = p.sku || p.amazon_sku;
      if (!mainSku) {
        mainSku = `CAD-${uuidv4().substring(0, 8).toUpperCase()}`;
        console.log(`Generated SKU ${mainSku} for ${p.name}`);
        await db.query("UPDATE products SET sku = ?, amazon_sku = ? WHERE id = ?", [mainSku, mainSku, p.id]);
      } else if (!p.sku || !p.amazon_sku) {
        // Sync them
        const existing = p.sku || p.amazon_sku;
        await db.query("UPDATE products SET sku = ?, amazon_sku = ? WHERE id = ?", [existing, existing, p.id]);
        mainSku = existing;
      }

      clientList.push({
        type: 'Product',
        name: p.name,
        id: p.id,
        sku: mainSku
      });

      // Update Variants
      const [variants] = await db.query("SELECT id, variant_name, sku, amazon_sku FROM product_variants WHERE product_id = ?", [p.id]);
      for (const v of variants) {
        let vSku = v.sku || v.amazon_sku;
        if (!vSku) {
          vSku = `${mainSku}-V-${uuidv4().substring(0, 4).toUpperCase()}`;
          await db.query("UPDATE product_variants SET sku = ?, amazon_sku = ? WHERE id = ?", [vSku, vSku, v.id]);
        }
        clientList.push({
          type: 'Variant',
          name: `${p.name} - ${v.variant_name}`,
          id: v.id,
          sku: vSku
        });
      }

      // Update Legacy Variants
      const [legacyVariants] = await db.query("SELECT id, color_name, amazon_sku FROM product_color_variants WHERE product_id = ?", [p.id]);
      for (const v of legacyVariants) {
        let vSku = v.amazon_sku;
        if (!vSku) {
          vSku = `${mainSku}-C-${uuidv4().substring(0, 4).toUpperCase()}`;
          await db.query("UPDATE product_color_variants SET amazon_sku = ? WHERE id = ?", [vSku, v.id]);
        }
        clientList.push({
          type: 'Legacy Variant',
          name: `${p.name} (${v.color_name})`,
          id: v.id,
          sku: vSku
        });
      }
    }

    console.log("\n\n--- LIST FOR CLIENT ---");
    console.table(clientList);
    
    // Also log in format easy to copy
    console.log("\nCopy-paste-able CSV format:");
    console.log("Type,Name,ID,Shippo_SKU");
    clientList.forEach(item => {
      console.log(`"${item.type}","${item.name}","${item.id}","${item.sku}"`);
    });

  } catch (err) {
    console.error("Update Error:", err);
  } finally {
    process.exit();
  }
}

update();
