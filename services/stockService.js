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
    const alerts = [];

    // 1. Check main products table
    const [lowStockProducts] = await db.execute(
      `SELECT id, name, sku, in_stock, availability, target_country 
       FROM products 
       WHERE (in_stock < 30 OR in_stock = 0) AND is_active = 1`
    );

    for (const product of lowStockProducts) {
      const { id, name, sku, in_stock, availability, target_country } = product;
      
      // Update availability if needed
      if (in_stock === 0 && availability !== "Out of Stock") {
        await db.execute("UPDATE products SET availability = 'Out of Stock' WHERE id = ?", [id]);
        logger.info(`Product ${name} (${sku}) updated to Out of Stock`);
      } else if (in_stock > 0 && availability === "Out of Stock") {
        await db.execute("UPDATE products SET availability = 'In Stock' WHERE id = ?", [id]);
        logger.info(`Product ${name} (${sku}) updated back to In Stock`);
      }

      // Collect alert for bulk send
      if (in_stock === 0) {
        alerts.push({ productName: name, currentStock: in_stock, sku, region: target_country || 'us' });
      }
      
      // Notify users if back in stock
      if (in_stock > 0 && availability === "Out of Stock") {
        await notifyUsersBackInStock(id, null, name, in_stock);
      }
    }

    // 2. Check product variants table
    const [lowStockVariants] = await db.execute(
      `SELECT v.id, v.product_id, p.name as product_name, p.target_country, v.color_name, v.amazon_sku, v.stock 
       FROM product_color_variants v
       JOIN products p ON v.product_id = p.id
       WHERE (v.stock < 30 OR v.stock = 0) AND v.is_active = 1`
    );

    for (const variant of lowStockVariants) {
      const { product_name, color_name, amazon_sku, stock, target_country } = variant;
      const fullName = `${product_name} (${color_name})`;
      
      // Collect alert for bulk send
      if (stock === 0) {
        alerts.push({ productName: fullName, currentStock: stock, sku: amazon_sku, region: target_country || 'us' });
      }

      // Notify users if back in stock
      if (stock > 0) {
        await notifyUsersBackInStock(variant.product_id, variant.id, fullName, stock);
      }
    }

    // 3. Send consolidated bulk email if needed
    if (alerts.length > 0) {
      const { sendBulkStockAlertEmail } = await import("./emailService.js");
      await sendBulkStockAlertEmail(alerts);
      logger.info(`Sent consolidated stock alert email for ${alerts.length} items.`);
    }

    logger.info(`Stock check complete. Processed ${lowStockProducts.length} products and ${lowStockVariants.length} variants.`);
    
    return {
      success: true,
      productsChecked: lowStockProducts.length,
      variantsChecked: lowStockVariants.length,
      alertsSent: alerts.length
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

async function notifyUsersBackInStock(productId, variantId, name, currentStock) {
  try {
    const query = variantId
      ? "SELECT id, email FROM stock_notifications WHERE product_id = ? AND variant_id = ? AND notified_at IS NULL"
      : "SELECT id, email FROM stock_notifications WHERE product_id = ? AND variant_id IS NULL AND notified_at IS NULL";
    
    const params = variantId ? [productId, variantId] : [productId];
    const [notifications] = await db.execute(query, params);

    if (notifications.length === 0) return;

    const { sendBackInStockEmail } = await import("./emailService.js");

    for (const note of notifications) {
      await sendBackInStockEmail(note.email, name, currentStock, productId);
      await db.execute("UPDATE stock_notifications SET notified_at = NOW() WHERE id = ?", [note.id]);
    }

    logger.info(`Notified ${notifications.length} users that ${name} is back in stock`);
  } catch (error) {
    logger.error(`Failed to notify users for ${name}: ${error.message}`);
  }
}

export default {
  checkInventoryLevels,
  startStockMonitoring
};
