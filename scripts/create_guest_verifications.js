import mysql from 'mysql2/promise';
import 'dotenv/config';

const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

await db.execute(`
  CREATE TABLE IF NOT EXISTS guest_verifications (
    id         CHAR(36)     NOT NULL DEFAULT (UUID()) PRIMARY KEY,
    email      VARCHAR(255) NOT NULL,
    otp_code   VARCHAR(10)  NOT NULL,
    otp_expiry DATETIME     NOT NULL,
    created_at DATETIME     DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_guest_email (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`);

console.log('✅ guest_verifications table created successfully');
await db.end();
