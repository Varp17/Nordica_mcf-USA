
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
dotenv.config();

async function setup() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    // 1. Create Invoices Table (Not in seed.sql)
    console.log('Creating invoices table...');
    await db.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id CHAR(36) PRIMARY KEY,
        order_id CHAR(36) NOT NULL,
        invoice_number VARCHAR(50) UNIQUE NOT NULL,
        total_amount DECIMAL(12,2) NOT NULL,
        tax_amount DECIMAL(12,2) DEFAULT 0,
        status ENUM('pending', 'paid', 'cancelled') DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 2. Add Admin User (Deleted by DROP TABLE users in seed.sql)
    console.log('Adding admin user...');
    const passwordHash = await bcrypt.hash('Admin@Secure123!', 10);
    const adminId = uuidv4();
    await db.query(`
      INSERT INTO users (id, email, password_hash, first_name, last_name, role, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = VALUES(role)
    `, [adminId, 'admin@detailguardz.com', passwordHash, 'Admin', 'User', 'admin', 1]);

    // 3. Ensure we have at least one test customer for dummy orders
    const [customers] = await db.query("SELECT id FROM users WHERE role = 'customer' LIMIT 1");
    if (!customers.length) {
       console.log('Adding test customer...');
       await db.query(`
          INSERT INTO users (id, email, password_hash, first_name, last_name, role, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?)
       `, [uuidv4(), 'customer@example.com', passwordHash, 'Test', 'Customer', 'customer', 1]);
    }

    console.log('SUCCESS: Admin user and invoices table setup complete.');
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await db.end();
  }
}
setup();
