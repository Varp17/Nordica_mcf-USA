
import db from '../config/database.js';
import fs from 'fs';

async function exportSql() {
  try {
    const [products] = await db.query("SELECT * FROM products ORDER BY country DESC, name ASC");
    let sql = "";

    for (const p of products) {
      const columns = Object.keys(p).filter(c => !['created_at', 'updated_at'].includes(c));
      const values = columns.map(c => {
        let val = p[c];
        if (val === null) return 'NULL';
        if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
        if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
        return val;
      });

      sql += `-- ${p.name} (${p.country})\n`;
      sql += `INSERT INTO products (\n  ${columns.join(', ')}\n) VALUES (\n  ${values.join(', ')}\n);\n\n`;
    }

    fs.writeFileSync('scripts/generated_inserts.sql', sql);
    console.log("Exported SQL to scripts/generated_inserts.sql");
  } catch (err) {
    console.error("Export Error:", err);
  } finally {
    process.exit();
  }
}

exportSql();
