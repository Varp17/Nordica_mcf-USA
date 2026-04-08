
import db from '../config/database.js';

async function checkJson() {
  try {
    const [rows] = await db.query("SELECT id, name, color_options FROM products WHERE country IN ('CAD', 'CA')");
    for (const row of rows) {
      if (row.color_options) {
        console.log(`Product: ${row.name}`);
        console.log(JSON.stringify(row.color_options, null, 2));
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}
checkJson();
