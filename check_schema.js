import 'dotenv/config';
import db from './config/database.js';

async function check() {
  try {
    const [cols] = await db.query("DESCRIBE order_items");
    console.log("COLUMNS FOR order_items:");
    console.table(cols);
    const [ordersCols] = await db.query("DESCRIBE orders");
    console.log("COLUMNS FOR orders:");
    console.table(ordersCols);
    const [tables] = await db.query("SHOW TABLES");
    console.log("TABLES IN DATABASE:");
    console.table(tables);

    const [prodCols] = await db.query("DESCRIBE products");
    console.log("COLUMNS FOR products:");
    console.table(prodCols);

    try {
        const [variantCols] = await db.query("DESCRIBE product_variants");
        console.log("COLUMNS FOR product_variants:");
        console.table(variantCols);
    } catch (e) {
        console.warn("Table 'product_variants' does not exist.");
    }

    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

check();
