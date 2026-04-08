
import db from '../config/database.js';

async function updateTshirtColors() {
  try {
    const sizeMap = {
      'Small': 'S',
      'Medium': 'M',
      'Large': 'L',
      'XL': 'XL',
      '2XL': '2XL',
      '3XL': '3XL'
    };
    const requestedSizes = ['Small', 'Medium', 'Large', 'XL', '2XL', '3XL'];

    // Find the T-shirt
    const [rows] = await db.query("SELECT id, name, sku, color_options FROM products WHERE name LIKE '%T-SHIRT WHITE%'");
    
    for (const p of rows) {
      const baseSku = p.sku;
      const newColorOptions = [];
      
      // Original color was White
      const baseColorSku = `${baseSku}-V-WHITE`;
      
      for (const size of requestedSizes) {
        newColorOptions.push({
          name: `White (${size})`,
          value: 'white',
          size: size,
          sku: `${baseColorSku}-${sizeMap[size]}`,
          image: "https://detailguardz.s3.us-east-1.amazonaws.com/assets/Canada Products/APPAREL  MERCHANDISE/TDGSHORTSLEEVESHIRT-WHITE_720x.webp",
          price: 24.99
        });
      }

      await db.query("UPDATE products SET color_options = ? WHERE id = ?", [JSON.stringify(newColorOptions), p.id]);
      console.log("Updated T-shirt " + p.name + " with " + newColorOptions.length + " size variants.");
    }
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}
updateTshirtColors();
