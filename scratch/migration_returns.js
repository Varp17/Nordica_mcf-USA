import db from '../config/database.js';
import logger from '../utils/logger.js';

async function migrate() {
  console.log('🚀 Starting migration...');
  try {
    const [columns] = await db.query('SHOW COLUMNS FROM orders');
    const columnNames = columns.map(c => c.Field);

    // 1. Add mcf_return_data JSON column
    if (!columnNames.includes('mcf_return_data')) {
      console.log('Adding mcf_return_data column...');
      await db.query(`
        ALTER TABLE orders 
        ADD COLUMN mcf_return_data JSON DEFAULT NULL AFTER mcf_tracking_ids
      `);
    } else {
      console.log('mcf_return_data column already exists.');
    }

    // 2. Add cancellation_otp and cancellation_otp_expiry columns
    if (!columnNames.includes('cancellation_otp')) {
      console.log('Adding cancellation_otp and expiry columns...');
      await db.query(`
        ALTER TABLE orders 
        ADD COLUMN cancellation_otp VARCHAR(10) DEFAULT NULL AFTER notes,
        ADD COLUMN cancellation_otp_expiry DATETIME DEFAULT NULL AFTER cancellation_otp
      `);
    } else {
      console.log('cancellation_otp columns already exist.');
    }

    console.log('✅ Migration successful!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migrate();
