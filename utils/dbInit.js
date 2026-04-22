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

    // 5. Schema Migrations — Safely add columns that may not exist yet
    //    These are idempotent: MySQL will throw if column exists, we catch it.
    const migrations = [
      // Orders table
      { col: 'orders.retry_count',       sql: "ALTER TABLE orders ADD COLUMN retry_count INT NOT NULL DEFAULT 0" },
      { col: 'orders.last_retry_at',     sql: "ALTER TABLE orders ADD COLUMN last_retry_at DATETIME DEFAULT NULL" },
      { col: 'orders.invoice_pdf_url',   sql: "ALTER TABLE orders ADD COLUMN invoice_pdf_url VARCHAR(500) DEFAULT NULL" },
      { col: 'orders.fulfillment_channel', sql: "ALTER TABLE orders ADD COLUMN fulfillment_channel VARCHAR(50) DEFAULT NULL" },
      { col: 'orders.fulfillment_error',   sql: "ALTER TABLE orders ADD COLUMN fulfillment_error TEXT DEFAULT NULL" },
      // Invoices table
      { col: 'invoices.fulfillment_channel', sql: "ALTER TABLE invoices ADD COLUMN fulfillment_channel VARCHAR(50) DEFAULT NULL" },
      // Performance index for retry job
      { col: 'orders.idx_orders_retry',  sql: "ALTER TABLE orders ADD INDEX idx_orders_retry (fulfillment_status, payment_status, retry_count)" },
      // Fulfillment Monitor columns (alert deduplication)
      { col: 'orders.stale_alerted_at',       sql: "ALTER TABLE orders ADD COLUMN stale_alerted_at DATETIME DEFAULT NULL" },
      { col: 'orders.exhausted_alerted_at',   sql: "ALTER TABLE orders ADD COLUMN exhausted_alerted_at DATETIME DEFAULT NULL" },
      { col: 'orders.ca_label_reminder_at',   sql: "ALTER TABLE orders ADD COLUMN ca_label_reminder_at DATETIME DEFAULT NULL" },
      { col: 'orders.is_paypal_verified',     sql: "ALTER TABLE orders ADD COLUMN is_paypal_verified TINYINT(1) DEFAULT 0" },
      { col: 'orders.paid_at',                sql: "ALTER TABLE orders ADD COLUMN paid_at DATETIME DEFAULT NULL" },
      { col: 'orders.idx_orders_stale_monitor', sql: "ALTER TABLE orders ADD INDEX idx_orders_stale_monitor (payment_status, fulfillment_status, paid_at, stale_alerted_at)" },
      // Shippo Order ID (missing in some environments)
      { col: 'orders.shippo_order_id', sql: "ALTER TABLE orders ADD COLUMN shippo_order_id VARCHAR(100) DEFAULT NULL" },
      { col: 'orders.cancellation_otp', sql: "ALTER TABLE orders ADD COLUMN cancellation_otp VARCHAR(10) DEFAULT NULL" },
      { col: 'orders.cancellation_otp_expiry', sql: "ALTER TABLE orders ADD COLUMN cancellation_otp_expiry DATETIME DEFAULT NULL" },
      // Collation Fixes (to prevent "Illegal mix of collations" errors)
      { col: 'orders.fix_collation',  sql: "ALTER TABLE orders CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci" },
      { col: 'return_requests.fix_collation', sql: "ALTER TABLE return_requests CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci" },
      { col: 'ticket_sequences.fix_collation', sql: "ALTER TABLE ticket_sequences CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci" },
      { col: 'users.fix_collation', sql: "ALTER TABLE users CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci" },
      // Contact Tickets Missing Columns
      { col: 'contact_tickets.source',           sql: "ALTER TABLE contact_tickets ADD COLUMN source VARCHAR(50) DEFAULT 'web_form'" },
      { col: 'contact_tickets.assigned_to',      sql: "ALTER TABLE contact_tickets ADD COLUMN assigned_to CHAR(36) DEFAULT NULL" },
      { col: 'contact_tickets.internal_notes',   sql: "ALTER TABLE contact_tickets ADD COLUMN internal_notes TEXT DEFAULT NULL" },
      { col: 'contact_tickets.response_message', sql: "ALTER TABLE contact_tickets ADD COLUMN response_message TEXT DEFAULT NULL" },
      { col: 'contact_tickets.responded_at',     sql: "ALTER TABLE contact_tickets ADD COLUMN responded_at DATETIME DEFAULT NULL" },
    ];

    for (const m of migrations) {
      try {
        // Safe check: Search if column or index exists before trying to add it
        if (m.col) {
          let exists = false;
          if (m.col.includes('idx_')) {
            // Index check
            const [table, indexName] = m.col.split('.');
            const [existing] = await db.execute(
              "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?",
              [table, indexName]
            );
            exists = existing.length > 0;
          } else {
            // Column check
            const [table, column] = m.col.split('.');
            const [existing] = await db.execute(
              "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
              [table, column]
            );
            exists = existing.length > 0;
          }

          if (exists) continue;
        }

        await db.execute(m.sql);
        logger.info(`   Migration applied: ${m.col}`);
      } catch (e) {
        // Fallback for indexes or unexpected errors (execute avoids logging if possible or we catch here)
        if (e.code === 'ER_DUP_FIELDNAME' || e.errno === 1060 || e.code === 'ER_DUP_KEYNAME' || e.errno === 1061) {
          // Already exists, skip
        } else {
          logger.warn(`   Migration warning for ${m.col}: ${e.message}`);
        }
      }
    }

    return true;
  } catch (err) {
    logger.error(`❌ DB Initialization failed: ${err.message}`);
    throw err; 
  }
}
