
import db from '../config/database.js';

async function findMoreApparel() {
  try {
    const [rows] = await db.query("SELECT id, name, sku, sizes, color_options, country FROM products WHERE category = 'Apparels' OR category = 'apparels'");
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}
findMoreApparel();
