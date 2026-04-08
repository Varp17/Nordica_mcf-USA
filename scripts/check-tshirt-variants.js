
import db from '../config/database.js';

async function check() {
  try {
    const [rows] = await db.query("SELECT * FROM product_variants WHERE product_id = '12e33285-2b91-11f1-ac48-767b5e3bd9b8'");
    console.log(JSON.stringify(rows, null, 2));
    
    // Also check product_color_variants just in case
    const [colorRows] = await db.query("SELECT * FROM product_color_variants WHERE product_id = '12e33285-2b91-11f1-ac48-767b5e3bd9b8'");
    console.log("Color Variants:", JSON.stringify(colorRows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}
check();
