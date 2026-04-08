
import db from '../config/database.js';
import fs from 'fs';

async function exportFullSql() {
  try {
    const [rows] = await db.query("SELECT * FROM products");
    let sql = "-- PRODUCT INSERTS\n";
    sql += "-- ============================================================\n\n";

    for (const r of rows) {
      const keys = Object.keys(r);
      const values = keys.map(k => {
        let val = r[k];
        if (val === null) return 'NULL';
        if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
        if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
        return val;
      });

      sql += `-- ${r.name} (${r.country || 'USA'})\n`;
      sql += `INSERT INTO products (\n  ${keys.join(', ')}\n) VALUES (\n  ${values.join(', ')}\n);\n\n`;
    }

    fs.writeFileSync('scripts/generated_inserts.sql', sql);
    console.log("Full SQL exported to scripts/generated_inserts.sql");
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}

exportFullSql();
