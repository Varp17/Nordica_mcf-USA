
import db from '../config/database.js';

async function check() {
  try {
    const [rows] = await db.query("SELECT id, name, sizes, color_options, country FROM products WHERE name LIKE '%T-shirt%' OR sizes IS NOT NULL");
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}
check();
