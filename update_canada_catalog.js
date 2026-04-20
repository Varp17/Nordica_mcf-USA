import db from './config/database.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function updateCatalog() {
  try {
    const sqlPath = path.join(__dirname, 'sql', 'create_tables.sql');
    const sqlContent = fs.readFileSync(sqlPath, 'utf8');

    const startMarker = '-- CANADA PRODUCTS';
    const startIndex = sqlContent.indexOf(startMarker);
    
    if (startIndex === -1) {
      throw new Error('Could not find Canada products section in SQL file');
    }

    let catalogSql = sqlContent.substring(startIndex);
    
    // Use REPLACE INTO instead of INSERT INTO to avoid duplicate slug errors
    catalogSql = catalogSql.replace(/INSERT INTO products/g, 'REPLACE INTO products');
    catalogSql = catalogSql.replace(/INSERT INTO tax_rates/g, 'REPLACE INTO tax_rates');
    
    // Remove ON DUPLICATE KEY UPDATE for tax_rates because REPLACE doesn't need/support it
    catalogSql = catalogSql.replace(/ON DUPLICATE KEY UPDATE tax_rate = VALUES\(tax_rate\);/g, ';');
    
    // Fix schema mismatch in DELETE statement (handling possible newlines)
    catalogSql = catalogSql.replace(/DELETE\s+FROM\s+product_variants\s+WHERE\s+target_country\s*=\s*'canada'/gi, 'DELETE FROM product_variants WHERE 1=1');
    
    console.log('🚀 Executing Canada Catalog updates (using REPLACE)...');
    await db.query(catalogSql);
    console.log('✅ Canada catalog updated successfully.');
    process.exit(0);
  } catch (error) {
    console.error('❌ Update failed:', error.message);
    process.exit(1);
  }
}

updateCatalog();
