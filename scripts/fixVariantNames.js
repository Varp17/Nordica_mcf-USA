import mysql from 'mysql2/promise';

async function fixNames() {
  const db = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'root',
    database: 'nordica_ecomsuM'
  });

  try {
    console.log("🚀 Fixing variant names and stock counts from legacy JSON...");
    const [products] = await db.execute("SELECT id, name, color_options FROM products WHERE is_active = 1");

    let totalUpdated = 0;

    for (const p of products) {
      if (!p.color_options) continue;

      let colors = [];
      try {
        colors = typeof p.color_options === 'string' ? JSON.parse(p.color_options) : p.color_options;
      } catch (e) { continue; }

      if (!Array.isArray(colors)) continue;

      for (const c of colors) {
        const sku = c.amazon_sku || c.sku || null;
        if (!sku) continue;

        const correctName = c.name || c.color_name || c.value || "Default";
        const correctColorCode = c.color || c.color_code || "#CCCCCC";

        // Update the variant table
        const [res] = await db.execute(
          `UPDATE product_color_variants 
           SET color_name = ?, color_code = ?, stock = ?, updated_at = NOW()
           WHERE product_id = ? AND amazon_sku = ?`,
          [correctName, correctColorCode, parseInt(c.stock) || 0, p.id, sku]
        );

        if (res.affectedRows > 0) totalUpdated++;
      }
    }

    console.log(`✅ Name/Stock fix complete. Updated ${totalUpdated} records.`);
  } catch (err) {
    console.error("❌ Fix failed:", err);
  } finally {
    await db.end();
  }
}

fixNames();
