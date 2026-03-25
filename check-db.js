import 'dotenv/config';
import mysql from 'mysql2/promise';

async function checkSchema() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '123456',
    database: 'detail_guardz_ecom'
  });
  
  const [usersCols] = await conn.execute('DESCRIBE users');
  console.log('Users columns:', usersCols.map(c => c.Field).join(', '));
  
  const [sampleUser] = await conn.execute('SELECT * FROM users LIMIT 1');
  if (sampleUser.length > 0) console.log('Sample user keys:', Object.keys(sampleUser[0]).join(', '));

  const [tables] = await conn.query('SHOW TABLES');
  console.log('All tables:', tables.map(t => Object.values(t)[0]).join(', '));

  const [sampleOrder] = await conn.execute("SELECT o.*, u.email, u.first_name, u.last_name FROM orders o LEFT JOIN users u ON o.user_id = u.id LIMIT 1");
  if (sampleOrder.length > 0) console.log('Join columns:', Object.keys(sampleOrder[0]).join(', '));

  await conn.end();
  process.exit(0);
}

checkSchema().catch(e => { console.error(e.message); process.exit(1); });
