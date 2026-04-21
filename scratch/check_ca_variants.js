import db from "../config/database.js";

async function run() {
  const [caProducts] = await db.execute("SELECT id, name, target_country FROM products WHERE target_country = 'canada'");
  console.log("Canada Products:", caProducts.length);
  
  for (const p of caProducts) {
    const [legacy] = await db.execute("SELECT id, color_name FROM product_color_variants WHERE product_id = ?", [p.id]);
    const [modern] = await db.execute("SELECT id, variant_name FROM product_variants WHERE product_id = ?", [p.id]);
    console.log(`Product: ${p.name}`);
    console.log(`  Legacy variants:`, legacy);
    console.log(`  Modern variants:`, modern);
  }
  process.exit(0);
}

run();
