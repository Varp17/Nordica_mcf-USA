import express from 'express';
import db from '../config/database.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * GET /api/debug/skus
 * Audits all US SKUs from the products table
 */
router.get('/skus', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT id, slug, name, 
             sku as main_sku,
             JSON_EXTRACT(color_options, '$[*].amazon_sku') as variant_skus,
             JSON_EXTRACT(specifications, '$.itemModelNumber') as item_model_number
      FROM products 
      WHERE (target_country IN ('us', 'both') OR country IN ('US', 'USA')) 
      AND is_active = 1
    `);

    // Parse JSON fields if they are strings (mysql2 sometimes returns them as strings depending on config)
    const auditedRows = rows.map(row => ({
      ...row,
      variant_skus: typeof row.variant_skus === 'string' ? JSON.parse(row.variant_skus) : row.variant_skus,
      item_model_number: typeof row.item_model_number === 'string' ? JSON.parse(row.item_model_number) : row.item_model_number
    }));

    res.json({
        success: true,
        count: auditedRows.length,
        products: auditedRows
    });
  } catch (err) {
    logger.error(`Debug SKU audit failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/debug/env
 * Basic environment status
 */
router.get('/env', (req, res) => {
  res.json({
    success: true,
    node_env: process.env.NODE_ENV,
    paypal_env: process.env.PAYPAL_ENV || 'sandbox (default)',
    has_paypal_client: !!process.env.PAYPAL_CLIENT_ID,
    has_paypal_secret: !!process.env.PAYPAL_CLIENT_SECRET,
    frontend_url: process.env.FRONTEND_URL ? 'set' : 'not set'
  });
});

export default router;
