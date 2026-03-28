import 'dotenv/config';
import mysql from 'mysql2/promise';

async function run() {
  const host = process.env.DB_HOST || 'localhost';
  const user = process.env.DB_USER || 'root';
  const password = process.env.DB_PASSWORD || 'root';
  const database = process.env.DB_NAME || 'nordica_ecomli';

  console.log(`\n--- Schema Fix Tool ---`);
  console.log(`Connecting to: ${user}@${host}/${database}...`);

  try {
    const db = await mysql.createConnection({
      host,
      user,
      password,
      database,
      multipleStatements: true
    });

    console.log("✅ Database connected successfully.");

    // 1. Fix 'products' table 'inventory_cache' column
    const [cols] = await db.query("DESCRIBE products");
    const hasInventoryCache = cols.some(c => c.Field === 'inventory_cache');

    if (!hasInventoryCache) {
      console.log("Adding 'inventory_cache' to 'products' table...");
      await db.query("ALTER TABLE products ADD COLUMN inventory_cache INT NOT NULL DEFAULT 0 AFTER country");
      console.log("✅ Added 'inventory_cache' column.");
    } else {
      console.log("ℹ️ 'inventory_cache' column already exists in 'products'.");
    }

    // 1b. Add 'amazon_sku' to 'products' if missing
    const hasAmazonSku = cols.some(c => c.Field === 'amazon_sku');
    if (!hasAmazonSku) {
      console.log("Adding 'amazon_sku' to 'products' table...");
      await db.query("ALTER TABLE products ADD COLUMN amazon_sku VARCHAR(100) DEFAULT NULL UNIQUE AFTER sku");
      console.log("✅ Added 'amazon_sku' column to products.");
    }

    // 2. Add 'product_variants' table if missing
    const [tables] = await db.query("SHOW TABLES");
    const tableNames = tables.map(t => Object.values(t)[0]);
    const hasProductVariants = tableNames.includes('product_variants');

    if (!hasProductVariants) {
      console.log("Creating 'product_variants' table...");
      const createTableSql = `
        CREATE TABLE product_variants (
          id               CHAR(36)      PRIMARY KEY DEFAULT (UUID()),
          product_id       CHAR(36)      NOT NULL,
          sku              VARCHAR(100)  DEFAULT NULL,
          amazon_sku       VARCHAR(100)  DEFAULT NULL,
          variant_name     VARCHAR(255)  DEFAULT NULL,
          price            DECIMAL(12,2) DEFAULT NULL,
          stock            INT           NOT NULL DEFAULT 0,
          attributes       JSON          DEFAULT NULL,
          is_active        TINYINT(1)    NOT NULL DEFAULT 1,
          created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
          INDEX idx_pv_product (product_id),
          INDEX idx_pv_sku (sku),
          INDEX idx_pv_amazon_sku (amazon_sku)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `;
      await db.query(createTableSql);
      console.log("✅ 'product_variants' table created.");
    } else {
      console.log("ℹ️ 'product_variants' table already exists.");
    }

    // 3. Fix 'order_items' table 'product_variant_id' column size
    console.log("Ensuring 'product_variant_id' in 'order_items' is VARCHAR(100)...");
    await db.query("ALTER TABLE order_items MODIFY COLUMN product_variant_id VARCHAR(100) DEFAULT NULL");
    console.log("✅ Updated 'product_variant_id' column size.");

    // 4. Fix 'users' table 'country' column size
    console.log("Ensuring 'country' in 'users' is VARCHAR(50)...");
    await db.query("ALTER TABLE users MODIFY COLUMN country VARCHAR(50) DEFAULT 'US'");
    console.log("✅ Updated 'country' column size in users table.");

    // 4b. Add 'pending_email' and 'pending_phone' if missing
    const [userCols] = await db.query("DESCRIBE users");
    const hasPendingEmail = userCols.some(c => c.Field === 'pending_email');
    if (!hasPendingEmail) {
      console.log("Adding 'pending_email' and 'pending_phone' to 'users' table...");
      await db.query("ALTER TABLE users ADD COLUMN pending_email VARCHAR(255) DEFAULT NULL AFTER otp_expiry");
      await db.query("ALTER TABLE users ADD COLUMN pending_phone VARCHAR(30) DEFAULT NULL AFTER pending_email");
      console.log("✅ Added 'pending' columns to users table.");
    }

    // 5. Add 'addresses' table if missing
    const hasAddressesTable = tableNames.includes('addresses');
    if (!hasAddressesTable) {
      console.log("Creating 'addresses' table...");
      const createAddressesSql = `
        CREATE TABLE addresses (
          id           CHAR(36)      PRIMARY KEY DEFAULT (UUID()),
          user_id      CHAR(36)      NOT NULL,
          first_name   VARCHAR(100)  NOT NULL,
          last_name    VARCHAR(100)  NOT NULL,
          phone        VARCHAR(30)   DEFAULT NULL,
          address1     VARCHAR(255)  NOT NULL,
          address2     VARCHAR(255)  DEFAULT NULL,
          city         VARCHAR(100)  NOT NULL,
          state        VARCHAR(100)  DEFAULT NULL,
          zip          VARCHAR(20)   NOT NULL,
          country      VARCHAR(50)   NOT NULL DEFAULT 'US',
          is_default   TINYINT(1)    NOT NULL DEFAULT 0,
          created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          INDEX idx_address_user (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `;
      await db.query(createAddressesSql);
      console.log("✅ 'addresses' table created.");
    } else {
      console.log("ℹ️ 'addresses' table already exists.");
    }

    // 6. Add 'mcf_tracking_ids' to 'orders' if missing
    const [orderCols] = await db.query("DESCRIBE orders");
    const hasMcfTrackingIds = orderCols.some(c => c.Field === 'mcf_tracking_ids');
    if (!hasMcfTrackingIds) {
      console.log("Adding 'mcf_tracking_ids' to 'orders' table...");
      await db.query("ALTER TABLE orders ADD COLUMN mcf_tracking_ids JSON DEFAULT NULL AFTER mcf_order_id");
      console.log("✅ Added 'mcf_tracking_ids' column to orders.");
    }

    await db.end();
    console.log(`--- Done! ---\n`);
    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Error during schema fix:`);
    console.error(error.message);
    if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      console.log(`\n💡 Tip: Your password in .env might be incorrect. Try changing DB_PASSWORD to empty or double check your MySQL setup.`);
    }
    process.exit(1);
  }
}

run();
