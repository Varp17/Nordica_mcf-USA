import 'dotenv/config';
import mysql from 'mysql2/promise';

async function test() {
  const configs = [
    { password: process.env.DB_PASSWORD, label: 'Env Password (root)' },
    { password: '', label: 'Empty Password' },
    { password: 'root', label: 'Hardcoded root' },
    { password: '123456', label: 'Fallback 123456' }
  ];

  for (const config of configs) {
    console.log(`Testing: ${config.label}...`);
    try {
      const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: config.password,
        database: process.env.DB_NAME
      });
      console.log(`✅ SUCCESS WITH: ${config.label}`);
      await conn.end();
      return;
    } catch (e) {
      console.log(`❌ FAILED: ${e.message}`);
    }
  }
}

test();
