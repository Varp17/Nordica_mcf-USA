
import db from '../config/database.js';
import fs from 'fs';

async function exportFullShippo() {
  try {
    const [products] = await db.query("SELECT * FROM products");
    let md = "# Final Shippo Registration List\n\n";
    md += "| Product Name | Color | Size | SKU | Registration Notes |\n";
    md += "|--------------|-------|------|-----|--------------------|\n";

    const sizeMap = {
      'Small': 'S',
      'Medium': 'M',
      'Large': 'L',
      'XL': 'XL',
      '2XL': '2XL',
      '3XL': '3XL'
    };

    const requestedSizes = ['Small', 'Medium', 'Large', 'XL', '2XL', '3XL'];

    for (const p of products) {
      const country = p.country || 'USA';
      const baseSku = p.sku || `${country}-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

      // 1. Check for apparel (T-shirts, hoodies, or sizes array)
      const isApparel = p.name.includes('T-shirt') || p.name.includes('Shirt') || p.name.includes('Hoodie') || (p.sizes && Array.isArray(p.sizes) && p.sizes.length > 0);

      // Handle color variants
      let colorOptions = [];
      if (Array.isArray(p.color_options)) {
        colorOptions = p.color_options;
      } else if (typeof p.color_options === 'string') {
        try { colorOptions = JSON.parse(p.color_options); } catch(e) { colorOptions = []; }
      }

      if (colorOptions.length === 0) {
        colorOptions = [{ name: 'N/A', sku: baseSku }];
      }

      for (const color of colorOptions) {
        const colorName = color.name || 'N/A';
        const colorSku = color.sku || `${baseSku}-V-${colorName.toUpperCase().replace(/\s+/g, '-')}`;

        if (isApparel) {
          // For apparel, generate SKUs for each size requested
          for (const sizeName of requestedSizes) {
            const sizeCode = sizeMap[sizeName] || sizeName.toUpperCase();
            const finalSku = `${colorSku}-${sizeCode}`;
            md += `| ${p.name} | ${colorName} | **${sizeName}** | \`${finalSku}\` | Full sizing variant |\n`;
          }
        } else {
          // Non-apparel product (usually one size or simple color variant)
          md += `| ${p.name} | ${colorName} | One Size | \`${colorSku}\` | Color variant |\n`;
        }
      }
    }

    fs.writeFileSync('shippo_registration_list.md', md);
    console.log("Full list exported to shippo_registration_list.md");

  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}

exportFullShippo();
