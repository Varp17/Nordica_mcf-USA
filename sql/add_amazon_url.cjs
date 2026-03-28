const mysql = require('mysql2/promise');

async function fix() {
  const connection = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'root',
    database: 'nordica_ecomli'
  });

  try {
    // MySQL 8.0/5.7 doesn't support 'ADD COLUMN IF NOT EXISTS' natively.
    await connection.execute(`ALTER TABLE products ADD COLUMN amazon_url VARCHAR(500)`);
    console.log('✅ amazon_url column added to products table');
  } catch (err) {
    if (err.errno === 1060) {
        console.log('ℹ️ Column already exists');
    } else {
        console.error('❌ Error updating schema:', err.message);
    }
  } finally {
    await connection.end();
  }
}

fix();
