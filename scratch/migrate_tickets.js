
import db from '../config/database.js';

async function migrate() {
    try {
        console.log('Starting migration for contact_tickets...');
        
        await db.query(`
            CREATE TABLE IF NOT EXISTS contact_tickets (
              id               CHAR(36)      PRIMARY KEY DEFAULT (UUID()),
              ticket_number    VARCHAR(20)   NOT NULL UNIQUE,
              name             VARCHAR(255)  NOT NULL,
              email            VARCHAR(255)  NOT NULL,
              subject          VARCHAR(255)  NOT NULL,
              message          TEXT          NOT NULL,
              country          VARCHAR(10)   NOT NULL DEFAULT 'US',
              status           ENUM('open', 'in_progress', 'resolved', 'closed') DEFAULT 'open',
              priority         ENUM('low', 'medium', 'high', 'urgent') DEFAULT 'medium',
              source           VARCHAR(50)   DEFAULT 'web_form',
              assigned_to      CHAR(36)      DEFAULT NULL,
              internal_notes   TEXT          DEFAULT NULL,
              response_message TEXT          DEFAULT NULL,
              responded_at     DATETIME      DEFAULT NULL,
              created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              INDEX idx_ticket_email (email),
              INDEX idx_ticket_status (status),
              INDEX idx_ticket_country (country),
              INDEX idx_ticket_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        console.log('✅ contact_tickets table created');

        await db.query(`
            CREATE TABLE IF NOT EXISTS ticket_sequences (
              year         INT NOT NULL,
              month        INT NOT NULL,
              last_number  INT NOT NULL DEFAULT 0,
              prefix       VARCHAR(10) DEFAULT 'TK',
              PRIMARY KEY (year, month)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        console.log('✅ ticket_sequences table created');

        console.log('Migration complete!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Migration failed:', err);
        process.exit(1);
    }
}

migrate();
