import mysql from 'mysql2/promise';

async function check() {
  const connection = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'root',
    database: 'ecom_nordica'
  });

  const [rows] = await connection.execute('SELECT id, name, color_options FROM products WHERE slug = "cad-hose-guide-4pk"');
  console.log(JSON.stringify(rows, null, 2));
  await connection.end();
}

check();
