require('dotenv').config();
const db = require('./config/database');
(async () => {
  try {
    const [rows] = await db.query('SELECT * FROM customers LIMIT 5');
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
