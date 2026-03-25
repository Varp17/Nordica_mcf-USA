import db from './config/database.js';

async function checkSkus() {
  try {
    const [rows] = await db.query(`
      SELECT p.slug, cv.variant_name, cv.amazon_sku 
      FROM product_color_variants cv 
      JOIN products p ON cv.product_id = p.id 
      WHERE p.slug = 'dirt-lock-car-wash-insert'
    `);
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}

checkSkus();
