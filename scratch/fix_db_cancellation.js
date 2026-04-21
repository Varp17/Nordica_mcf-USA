import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

async function fixDatabase() {
    const dbName = process.env.DB_NAME || 'ecom_nordica';
    const config = {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '3306', 10),
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || 'root',
        database: dbName,
        multipleStatements: true,
    };

    console.log(`🔗 Connecting to database '${dbName}'...`);
    
    let connection;
    try {
        connection = await mysql.createConnection(config);
        console.log('✅ Connected to MySQL.');

        console.log('🛠️ Adding cancellation columns to orders table...');
        
        // Use a safe approach to add columns if they don't exist
        const [columns] = await connection.query(`SHOW COLUMNS FROM orders LIKE 'cancellation_otp'`);
        
        if (columns.length === 0) {
            await connection.query(`
                ALTER TABLE orders 
                ADD COLUMN cancellation_otp VARCHAR(10) DEFAULT NULL AFTER shippo_label_url,
                ADD COLUMN cancellation_otp_expiry DATETIME DEFAULT NULL AFTER cancellation_otp;
            `);
            console.log('✅ Columns added successfully.');
        } else {
            console.log('ℹ️ Columns already exist.');
        }

    } catch (error) {
        console.error('❌ Database fix failed:');
        console.error(error.message);
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

fixDatabase();
