import db from "../config/database.js";

async function run() {
  const [caProducts] = await db.execute("SELECT id, name, target_country, color_options FROM products WHERE target_country = 'canada'");
  
  for (const p of caProducts) {
    console.log(`Product: ${p.name}`);
    console.log(`  color_options:`, p.color_options);
  }
  process.exit(0);
}

run();
