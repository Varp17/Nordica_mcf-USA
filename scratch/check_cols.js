import db from "../config/database.js";

async function run() {
  const [cols] = await db.execute("SHOW COLUMNS FROM product_variants");
  console.log("product_variants columns:", cols.map(c => c.Field));
  
  const [cols2] = await db.execute("SHOW COLUMNS FROM product_color_variants");
  console.log("product_color_variants columns:", cols2.map(c => c.Field));
  
  process.exit(0);
}

run();
