import db from "../config/database.js";

async function run() {
  const [variants] = await db.execute(`
    SELECT v.id, v.color_name, v.target_country, p.name as product_name, p.target_country as product_target_country
    FROM product_color_variants v
    JOIN products p ON v.product_id = p.id
    WHERE p.target_country = 'canada'
  `);
  
  console.table(variants);
  process.exit(0);
}

run();
