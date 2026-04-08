import 'dotenv/config';
import mysql from 'mysql2/promise';
import logger from '../utils/logger.js';

// Create a connection pool — reused across all requests
// Support both individual variables and single connection URL (standard for Render/Railway)
const rawPoolConfig = process.env.DATABASE_URL 
  ? process.env.DATABASE_URL 
  : {
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || '3306', 10),
      user:     process.env.DB_USER     || 'root',
      password: process.env.DB_PASSWORD || 'root',
      database: process.env.DB_NAME     || 'nordica_ecomsun',
      waitForConnections: true,
      connectionLimit:    parseInt(process.env.DB_POOL_MAX || '10', 10),
      multipleStatements: true,
      dateStrings: false,
      timezone: '+00:00'
    };

// Automatically append multipleStatements=true to connection strings if missing
let poolConfig = rawPoolConfig;
if (typeof poolConfig === 'string' && !poolConfig.includes('multipleStatements=true')) {
  poolConfig += poolConfig.includes('?') ? '&multipleStatements=true' : '?multipleStatements=true';
}

const pool = mysql.createPool(poolConfig);

// Wrap pool.query so callers can do: db.query(sql, params)
const db = {
  /**
   * Execute a query on a pooled connection.
   * Returns [rows, fields]
   */
  async query(sql, params = []) {
    try {
      const [rows, fields] = await pool.query(sql, params);
      return [rows, fields];
    } catch (err) {
      logger.error(`DB Query Error: ${err.message} | SQL: ${sql}`);
      throw err;
    }
  },

  /**
   * Execute a query on a pooled connection using prepared statements.
   * Returns [rows, fields]
   */
  async execute(sql, params = []) {
    try {
      const [rows, fields] = await pool.execute(sql, params);
      return [rows, fields];
    } catch (err) {
      logger.error(`DB Execute Error: ${err.message} | SQL: ${sql}`);
      throw err;
    }
  },

  /**
   * Get a raw connection for transactions.
   * Always call conn.release() in a finally block.
   */
  async getConnection() {
    return pool.getConnection();
  },

  /**
   * Gracefully drain the pool (used on SIGTERM)
   */
  async end() {
    await pool.end();
    logger.info('MySQL pool closed');
  }
};

export default db;
export { pool };
