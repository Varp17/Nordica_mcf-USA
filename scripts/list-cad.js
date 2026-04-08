
import db from '../config/database.js';

async function list() {
  try {
    const [rows] = await db.query("SELECT id, name, sku, category, country FROM products WHERE country = 'CAD'");
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}
list();
