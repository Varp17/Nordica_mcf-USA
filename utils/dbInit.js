import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Production-ready Database Initializer
 * Ensures tables exist and admin is seeded/updated on every boot.
 */
export async function initializeDatabase(db) {
  try {
    logger.info('🛠️ Checking database health and schema...');

    // 1. Check if 'users' table exists 
    const [tables] = await db.query("SHOW TABLES LIKE 'users'");
    
    if (tables.length === 0) {
      logger.info('📂 No tables found. Running initial schema setup (create_tables.sql)...');
      const sqlPath = path.join(__dirname, '..', 'sql', 'create_tables.sql');
      
      if (fs.existsSync(sqlPath)) {
        let sql = fs.readFileSync(sqlPath, 'utf8');
        
        // Multi-statement SQL execution
        await db.query(sql);
        logger.info('✅ Database schema created successfully.');
      } else {
        logger.error(`❌ SQL file not found at ${sqlPath}`);
      }
    }

    // 2. Ensure Admin User exists (Idempotent)
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@detailguardz.com';
    const adminPass = process.env.ADMIN_SEED_PASSWORD || 'Admin@Secure123!';
    
    // Hash the password for the admin (from .env)
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(adminPass, saltRounds);

    const [adminRows] = await db.query("SELECT id FROM users WHERE email = ?", [adminEmail]);

    if (adminRows.length > 0) {
      // Sync admin password and ensure role is superadmin
      await db.execute(
        "UPDATE users SET password_hash = ?, role = 'superadmin', is_active = 1 WHERE email = ?",
        [passwordHash, adminEmail]
      );
      logger.info(`✅ Admin credentials synchronized from .env for ${adminEmail}`);
    } else {
      // Create new superadmin
      await db.execute(
        "INSERT INTO users (id, email, password_hash, first_name, last_name, role, is_active) VALUES (UUID(), ?, ?, 'Admin', 'User', 'superadmin', 1)",
        [adminEmail, passwordHash]
      );
      logger.info(`✨ New Admin account created: ${adminEmail}`);
    }

    return true;
  } catch (err) {
    logger.error(`❌ DB Initialization failed: ${err.message}`);
    throw err; // Fail hard in production if DB isn't ready
  }
}
