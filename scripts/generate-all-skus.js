
import db from '../config/database.js';
import { v4 as uuidv4 } from 'uuid';

async function updateAll() {
  try {
    const [products] = await db.query("SELECT id, name, sku, amazon_sku, country, color_options FROM products");
    console.log(`Processing all ${products.length} products...`);

    const clientList = [];

    for (const p of products) {
      let mainSku = p.sku || p.amazon_sku;
      let countryPrefix = (p.country === 'CAD' || p.country === 'CA') ? 'CAD' : 'USA';
      
      if (!mainSku) {
        mainSku = `${countryPrefix}-${uuidv4().substring(0, 8).toUpperCase()}`;
        console.log(`Generated SKU ${mainSku} for ${p.name}`);
        await db.query("UPDATE products SET sku = ?, amazon_sku = ? WHERE id = ?", [mainSku, mainSku, p.id]);
      } else if (!p.sku || !p.amazon_sku) {
        const existing = p.sku || p.amazon_sku;
        mainSku = existing;
        await db.query("UPDATE products SET sku = ?, amazon_sku = ? WHERE id = ?", [existing, existing, p.id]);
      }

      clientList.push({
        Type: 'Product',
        Country: p.country,
        Name: p.name,
        Merchant_ID: p.id,
        Shippo_SKU: mainSku
      });

      // Update color_options JSON variants
      let options = p.color_options;
      if (typeof options === 'string' && options) {
        try { options = JSON.parse(options); } catch (e) { options = null; }
      }

      if (options && Array.isArray(options)) {
        let changed = false;
        for (const opt of options) {
          if (!opt.sku && !opt.amazon_sku) {
            const suffix = (opt.value || opt.name || 'UNKNOWN').replace(/\s+/g, '-').toUpperCase();
            const vSku = `${mainSku}-V-${suffix}`;
            opt.sku = vSku;
            opt.amazon_sku = vSku;
            changed = true;
            console.log(`Generated SKU ${vSku} for ${p.name} variant ${opt.name}`);
          } else if (!opt.sku || !opt.amazon_sku) {
            const existing = opt.sku || opt.amazon_sku;
            opt.sku = existing;
            opt.amazon_sku = existing;
            changed = true;
          }
          clientList.push({
            Type: 'Variant',
            Country: p.country,
            Name: `${p.name} (${opt.name || opt.value})`,
            Merchant_ID: opt.sku, // Using SKU as ID for variants in JSON
            Shippo_SKU: opt.sku
          });
        }
        if (changed) {
          await db.query("UPDATE products SET color_options = ? WHERE id = ?", [JSON.stringify(options), p.id]);
        }
      }

      // Update product_variants table (if any)
      const [variants] = await db.query("SELECT id, variant_name, sku, amazon_sku FROM product_variants WHERE product_id = ?", [p.id]);
      for (const v of variants) {
        let vSku = v.sku || v.amazon_sku;
        if (!vSku) {
          vSku = `${mainSku}-PV-${uuidv4().substring(0, 4).toUpperCase()}`;
          await db.query("UPDATE product_variants SET sku = ?, amazon_sku = ? WHERE id = ?", [vSku, vSku, v.id]);
        }
        clientList.push({
          Type: 'Product Variant Table',
          Country: p.country,
          Name: `${p.name} - ${v.variant_name}`,
          Merchant_ID: v.id,
          Shippo_SKU: vSku
        });
      }

      // Update product_color_variants legacy table (if any)
      const [legacyVariants] = await db.query("SELECT id, color_name, amazon_sku FROM product_color_variants WHERE product_id = ?", [p.id]);
      for (const v of legacyVariants) {
        let vSku = v.amazon_sku;
        if (!vSku) {
          vSku = `${mainSku}-CV-${uuidv4().substring(0, 4).toUpperCase()}`;
          await db.query("UPDATE product_color_variants SET amazon_sku = ? WHERE id = ?", [vSku, v.id]);
        }
        clientList.push({
          Type: 'Legacy Variant Table',
          Country: p.country,
          Name: `${p.name} (${v.color_name})`,
          Merchant_ID: v.id,
          Shippo_SKU: vSku
        });
      }
    }

    console.log(JSON.stringify(clientList, null, 2));

  } catch (err) {
    console.error("Update All Error:", err);
  } finally {
    process.exit();
  }
}

updateAll();
