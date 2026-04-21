import db from '../config/database.js';

async function migrate() {
  console.log('🚀 Creating return_requests table...');
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS return_requests (
        id VARCHAR(36) PRIMARY KEY,
        order_id VARCHAR(36) NOT NULL,
        customer_id VARCHAR(36),
        reason_code VARCHAR(100),
        customer_feedback TEXT,
        status ENUM('pending', 'approved', 'rejected', 'completed') DEFAULT 'pending',
        items JSON, -- Store which items are being returned
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id)
      )
    `);
    console.log('✅ table created!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migrate();
