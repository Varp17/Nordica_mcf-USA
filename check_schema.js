import db from './config/database.js';

async function check() {
  try {
    const [cols] = await db.query("DESCRIBE order_items");
    console.log("COLUMNS FOR order_items:");
    console.table(cols);
    const [ordersCols] = await db.query("DESCRIBE orders");
    console.log("COLUMNS FOR orders:");
    console.table(ordersCols);
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

check();
