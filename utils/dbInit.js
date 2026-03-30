import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Split SQL script into individual statements, handling DELIMITER blocks.
 * This is necessary because MySQL drivers don't support the DELIMITER command.
 */
function parseSqlStats(sql) {
  const statements = [];
  let currentDelimiter = ';';
  let buffer = '';
  
  const lines = sql.split(/\r?\n/);
  
  for (let line of lines) {
    const trimmedLine = line.trim();
    
    // Skip empty lines or pure comment lines for parsing, but keep content for the buffer
    if (!trimmedLine || trimmedLine.startsWith('--')) continue;

    // Handle DELIMITER change command
    if (trimmedLine.toUpperCase().startsWith('DELIMITER')) {
      const parts = trimmedLine.split(/\s+/);
      if (parts.length > 1) {
        currentDelimiter = parts[1];
      }
      continue;
    }

    buffer += line + '\n';

    // If the line ends with the current delimiter, we've reached the end of a statement
    if (trimmedLine.endsWith(currentDelimiter)) {
      let stmt = buffer.trim();
      // Remove trailing delimiter
      if (stmt.endsWith(currentDelimiter)) {
        stmt = stmt.slice(0, -currentDelimiter.length).trim();
      }
      if (stmt) statements.push(stmt);
      buffer = '';
    }
  }
  return statements;
}

export async function initializeDatabase(db) {
  try {
    logger.info('🛠️ Checking database health and schema...');

    // 1. Check if tables exist
    const [tables] = await db.query("SHOW TABLES LIKE 'users'");
    
    if (tables.length === 0) {
      logger.info('📂 No tables found. Running initial schema setup (create_tables.sql)...');
      const sqlPath = path.join(__dirname, '..', 'sql', 'create_tables.sql');
      
      if (fs.existsSync(sqlPath)) {
        const rawSql = fs.readFileSync(sqlPath, 'utf8');
        const statements = parseSqlStats(rawSql);
        
        logger.info(`🚀 Executing ${statements.length} SQL statements sequentially...`);
        
        for (let i = 0; i < statements.length; i++) {
          try {
            await db.query(statements[i]);
          } catch (stmtErr) {
            logger.error(`❌ SQL Error in statement #${i + 1} near: "${statements[i].substring(0, 100)}..."`);
            throw stmtErr;
          }
        }
        logger.info('✅ Database schema created successfully.');
      } else {
        logger.error(`❌ SQL file not found at ${sqlPath}`);
      }
    }

    // 2. Ensure Admin User exists (Idempotent)
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@detailguardz.com';
    const adminPass = process.env.ADMIN_SEED_PASSWORD || 'Admin@Secure123!';
    
    logger.info('Adding admin user...');
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(adminPass, saltRounds);

    await db.query(`
      INSERT INTO users (id, email, password_hash, first_name, last_name, role, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'superadmin'
    `, [uuidv4(), adminEmail, passwordHash, 'Admin', 'User', 'superadmin', 1]);

    // 3. Ensure we have at least one test customer for dummy orders
    const [customers] = await db.query("SELECT id FROM users WHERE role = 'customer' LIMIT 1");
    if (!customers.length) {
       logger.info('Adding test customer...');
       await db.query(`
          INSERT INTO users (id, email, password_hash, first_name, last_name, role, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?)
       `, [uuidv4(), 'customer@example.com', passwordHash, 'Test', 'Customer', 'customer', 1]);
    }

    // 4. Ensure customer1@test.com exists
    await db.query(`
      INSERT INTO users (id, email, password_hash, first_name, last_name, role, is_active, is_email_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE email = email
    `, [uuidv4(), 'customer1@test.com', passwordHash, 'Customer', 'One', 'customer', 1]);

    logger.info('SUCCESS: Admin user and test customers setup complete.');

    return true;
  } catch (err) {
    logger.error(`❌ DB Initialization failed: ${err.message}`);
    throw err; 
  }
}
