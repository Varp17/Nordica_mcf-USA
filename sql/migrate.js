import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

// Setup __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

console.log('Env loaded from:', path.join(__dirname, '../.env'));
console.log('DB_HOST:', process.env.DB_HOST);
console.log('DB_NAME:', process.env.DB_NAME);

async function migrate() {
    const dbName = process.env.DB_NAME || 'ecom_nordica';
    const config = {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '3306', 10),
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || 'root',
        multipleStatements: true,
    };

    console.log(`🔗 Connecting to MySQL at ${config.host}:${config.port}...`);
    
    let connection;
    try {
        connection = await mysql.createConnection(config);
        console.log('✅ Connected to MySQL server.');

        // 1. Create database if it doesn't exist
        console.log(`📡 Ensuring database '${dbName}' exists...`);
        await connection.query(`CREATE DATABASE IF NOT EXISTS ${dbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
        
        // 2. Select the database
        await connection.query(`USE ${dbName};`);
        console.log(`✅ Using database: ${dbName}`);

        // 3. Read and execute create_tables.sql
        const sqlPath = path.join(__dirname, 'create_tables.sql');
        if (!fs.existsSync(sqlPath)) {
            throw new Error(`Migration file not found at ${sqlPath}`);
        }

        console.log('📂 Reading create_tables.sql...');
        let sql = fs.readFileSync(sqlPath, 'utf8');

        // 4. CLEAN UP SQL (Remove DELIMITER commands for driver compatibility)
        console.log('🛠️ Normalizing SQL for driver compatibility...');
        sql = sql
            .replace(/^DELIMITER\s+\$\$.*$/gm, '')
            .replace(/^DELIMITER\s+\/\/.*$/gm, '')
            .replace(/^DELIMITER\s+;.*$/gm, '')
            .replace(/\$\$\s*$/gm, ';')
            .replace(/\s+\/\/\s*$/gm, ';')
            .replace(/[\u2018\u2019\u201A\u201B]/g, "''") 
            .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
            .replace(/[\u2013\u2014]/g, '-');

        console.log('🚀 Executing schema migration... (this might take a few seconds)');
        await connection.query(sql);
        console.log('✅ Schema migration and initial seeding completed successfully.');

    } catch (error) {
        console.error('❌ Migration failed:');
        console.error(error.message);
        if (error.sql) {
            console.error('Error near SQL snippet:', error.sql.slice(0, 200));
        }
        process.exit(1);
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

migrate();
