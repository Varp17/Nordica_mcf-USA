
import db from '../config/database.js';
import fs from 'fs';

async function generateApparelSkus() {
  try {
    // Find all products that are likely apparel or have sizes
    const [products] = await db.query("SELECT id, name, sku, sizes, color_options, country FROM products WHERE name LIKE '%T-shirt%' OR name LIKE '%Hoodie%' OR name LIKE '%Shirt%' OR category = 'Apparels' OR sizes IS NOT NULL");
    
    // Explicit list of sizes requested by the user
    const requestedSizes = ['Small', 'Medium', 'Large', 'XL', '2XL', '3XL'];

    const sizeMap = {
      'Small': 'S',
      'Medium': 'M',
      'Large': 'L',
      'XL': 'XL',
      '2XL': '2XL',
      '3XL': '3XL'
    };

    const registrationList = [];

    for (const p of products) {
      // Ensure product has a base SKU
      const productSku = p.sku || `CAD-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
      
      // Use the explicit list for any apparel-related product
      const sizes = requestedSizes;
      
      // Parse color options
      let colorOptions = [];
      if (Array.isArray(p.color_options)) {
          colorOptions = p.color_options;
      } else if (typeof p.color_options === 'string') {
          try { colorOptions = JSON.parse(p.color_options); } catch(e) { colorOptions = []; }
      }
      
      if (colorOptions.length === 0) {
          colorOptions = [{ name: 'Default', sku: productSku }];
      }

      for (const color of colorOptions) {
        const colorName = color.name || 'Default';
        let baseVariantSku = color.sku || `${productSku}-V-${colorName.toUpperCase().replace(/\s+/g, '-')}`;

        for (const sizeName of sizes) {
          const sizeCode = sizeMap[sizeName] || sizeName.toUpperCase();
          const finalSku = `${baseVariantSku}-${sizeCode}`;
          
          registrationList.push({
            productName: p.name,
            color: colorName,
            size: sizeName,
            sku: finalSku,
            country: p.country
          });
        }
      }
    }

    // Save to a markdown file for the user
    let md = "# Apparel Detailed Registration List (Every Color & Size Color Combination)\n\n";
    md += "| Product Name | Color | Size | SKU | Country |\n";
    md += "|--------------|-------|------|-----|---------|\n";
    for (const item of registrationList) {
      md += `| ${item.productName} | ${item.color} | ${item.size} | \`${item.sku}\` | ${item.country} |\n`;
    }

    fs.writeFileSync('apparel_shippo_registration_list.md', md);
    console.log("SUCCESS: Generated " + registrationList.length + " SKUs for sizes.");
    console.log("Saved to apparel_shippo_registration_list.md");

  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}

generateApparelSkus();
