import db from "../config/database.js";
import { sendStockAlertEmail } from "./emailService.js";
import logger from "../utils/logger.js";

/**
 * Stock Monitoring Service
 * ────────────────────────
 * Checks for low or out-of-stock products/variants and sends alerts to admin.
 * Also updates product availability status.
 */

export async function checkInventoryLevels() {
  try {
    logger.info("Running stock inventory check...");

    // 1. Check main products table
    const [lowStockProducts] = await db.execute(
      `SELECT id, name, sku, in_stock, availability 
       FROM products 
       WHERE (in_stock < 30 OR in_stock = 0) AND is_active = 1`
    );

    for (const product of lowStockProducts) {
      const { id, name, sku, in_stock, availability } = product;
      
      // Update availability if needed
      if (in_stock === 0 && availability !== "Out of Stock") {
        await db.execute("UPDATE products SET availability = 'Out of Stock' WHERE id = ?", [id]);
        logger.info(`Product ${name} (${sku}) updated to Out of Stock`);
      } else if (in_stock > 0 && availability === "Out of Stock") {
        await db.execute("UPDATE products SET availability = 'In Stock' WHERE id = ?", [id]);
        logger.info(`Product ${name} (${sku}) updated back to In Stock`);
      }

      // Send alert (Disabled per user request)
      // await sendStockAlertEmail(name, in_stock, sku);
    }

    // 2. Check product variants table
    const [lowStockVariants] = await db.execute(
      `SELECT v.id, p.name as product_name, v.color_name, v.amazon_sku, v.stock 
       FROM product_color_variants v
       JOIN products p ON v.product_id = p.id
       WHERE (v.stock < 30 OR v.stock = 0) AND v.is_active = 1`
    );

    for (const variant of lowStockVariants) {
      const { product_name, color_name, amazon_sku, stock } = variant;
      const fullName = `${product_name} (${color_name})`;
      
      // Send alert (Disabled per user request)
      // await sendStockAlertEmail(fullName, stock, amazon_sku);
    }

    logger.info(`Stock check complete. Processed ${lowStockProducts.length} products and ${lowStockVariants.length} variants.`);
    
    return {
      success: true,
      productsChecked: lowStockProducts.length,
      variantsChecked: lowStockVariants.length
    };
  } catch (error) {
    logger.error("Stock check failed:", error);
    return { success: false, error: error.message };
  }
}

// Start a periodic check every 1 hour (updated from 6 hours)
export function startStockMonitoring(intervalMs = 1 * 60 * 60 * 1000) {
  logger.info(`Stock monitoring started (Interval: ${intervalMs / 3600000} hours)`);
  
  // Run once on startup
  setTimeout(() => checkInventoryLevels(), 5000);
  
  // Set interval
  setInterval(() => checkInventoryLevels(), intervalMs);
}

export default {
  checkInventoryLevels,
  startStockMonitoring
};
