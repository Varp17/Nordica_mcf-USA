'use strict';

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function runSeed() {
  const dbName = process.env.DB_NAME || 'detailgarudzcanada';
  
  const initialConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
    charset: 'utf8mb4'
  };

  console.log('🔗 Connecting to MySQL Server...');
  let conn = await mysql.createConnection(initialConfig);

  try {
    // 1. ENSURE DATABASE EXISTS
    console.log(`🌐 Ensuring database '${dbName}' exists...`);
    await conn.query(`CREATE DATABASE IF NOT EXISTS ${dbName};`);
    await conn.query(`USE ${dbName};`);
    console.log(`✅ Using database: ${dbName}`);

    // 2. READ SEED FILE
    console.log('📂 Reading seed.sql...');
    let seedSql = fs.readFileSync(path.join(__dirname, 'sql', 'seed.sql'), 'utf8');

    // 3. CLEAN UP SQL
    console.log('🛠️ Normalizing SQL for driver compatibility...');
    seedSql = seedSql
        .replace(/^DELIMITER\s+\/\/.*$/gm, '')
        .replace(/^DELIMITER\s+;.*$/gm, '')
        .replace(/\s\/\/\s*$/gm, ';')
        .replace(/[\u2018\u2019\u201A\u201B]/g, "''") 
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
        .replace(/[\u2013\u2014]/g, '-');

    // 4. EXECUTE SEED
    console.log('🚀 Executing seed.sql... (This may take 10-20 seconds)');
    await conn.query(seedSql);
    console.log('✅ Base schema and products seeded successfully.');

    // 5. SYNC VARIANTS (Essential for Fulfillment)
    console.log('🔄 Indexing variants for fast lookup...');
    
    const [products] = await conn.query('SELECT id, name, color_options, country, price FROM products');
    
    let variantCount = 0;
    for (const product of products) {
      if (!product.color_options) continue;
      
      let options = typeof product.color_options === 'string' 
        ? JSON.parse(product.color_options) 
        : product.color_options;

      if (Array.isArray(options)) {
        for (const opt of options) {
          const sku = opt.sku || opt.amazon_sku || opt.asin || `VARIANT-${Math.random().toString(36).substr(2, 6)}`;
          const price = opt.price || product.price || 0;
          const color = opt.value || opt.color || opt.name || 'Default';
          const variantName = opt.name || color;
          
          await conn.query(
            `INSERT INTO product_color_variants 
             (id, product_id, variant_name, color_name, color, country, amazon_sku, price, stock, is_active)
             VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, 100, 1)`,
            [product.id, variantName, variantName, color, product.country || 'US', sku, price]
          );
          variantCount++;
        }
      }
    }
    console.log(`✨ SUCCESS: ${variantCount} color variants indexed for ${products.length} products.`);

    // Final verification
    const [row] = await conn.query('SELECT COUNT(*) as count FROM products');
    console.log(`📊 Result: ${row[0].count} products currently in database: ${dbName}`);

  } catch (err) {
    console.error('❌ SEED ERROR:', err.message);
    if (err.sql) {
        console.log('Error found near SQL snippet:', err.sql.substring(0, 500));
    }
  } finally {
    await conn.end();
    process.exit();
  }
}

runSeed();
