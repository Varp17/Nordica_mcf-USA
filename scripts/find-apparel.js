
import db from '../config/database.js';

async function find() {
  try {
    const [rows] = await db.query("SELECT id, name, sizes, color_options, country FROM products WHERE name LIKE '%Shirt%' OR name LIKE '%Hoodie%' OR name LIKE '%Apparel%' OR sizes IS NOT NULL");
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}
find();
