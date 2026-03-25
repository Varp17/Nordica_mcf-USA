import db from './config/database.js';
const [rows] = await db.query('SELECT id, name, sku, slug, specifications, color_options FROM products WHERE specifications LIKE "%DG-DL-SAP-WHT%" OR sku = "DG-DL-SAP-WHT"');
console.log(JSON.stringify(rows, null, 2));
process.exit(0);
