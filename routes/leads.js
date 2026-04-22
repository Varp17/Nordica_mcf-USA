import express from 'express';
import db from '../config/database.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

/**
 * POST /api/leads/capture
 * Captures an abandoned checkout / lead from the frontend.
 */
router.post('/capture', async (req, res) => {
  try {
    const { 
      id, email, firstName, lastName, phone, country,
      city, state, zip, shippingAddress,
      items, subtotal, shippingCost, tax, total
    } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required to capture lead.' });
    }

    // Check if a lead with this specific session ID already exists
    const [existing] = await db.execute(
      'SELECT id FROM abandoned_checkouts WHERE id = ? LIMIT 1',
      [id || 'null']
    );

    if (existing.length > 0) {
      // Update existing lead
      await db.execute(
        `UPDATE abandoned_checkouts SET 
          first_name = ?, last_name = ?, phone = ?, country = ?,
          city = ?, state = ?, zip = ?, address_json = ?,
          cart_items = ?, subtotal = ?, shipping_cost = ?, 
          tax_amount = ?, total_amount = ?, updated_at = NOW()
         WHERE id = ?`,
        [
          firstName || null, lastName || null, phone || null, country || 'US',
          city || null, state || null, zip || null, JSON.stringify(shippingAddress || {}),
          JSON.stringify(items || []), subtotal || 0, shippingCost || 0, 
          tax || 0, total || 0, existing[0].id
        ]
      );
      return res.json({ success: true, leadId: existing[0].id, message: 'Lead updated.' });
    } else {
      // Create new lead
      const leadId = id || uuidv4();
      await db.execute(
        `INSERT INTO abandoned_checkouts (
          id, email, first_name, last_name, phone, country,
          city, state, zip, address_json,
          cart_items, subtotal, shipping_cost, tax_amount, total_amount,
          status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [
          leadId, email, firstName || null, lastName || null, phone || null, country || 'US',
          city || null, state || null, zip || null, JSON.stringify(shippingAddress || {}),
          JSON.stringify(items || []), subtotal || 0, shippingCost || 0, tax || 0, total || 0
        ]
      );
      return res.json({ success: true, leadId, message: 'Lead captured.' });
    }
  } catch (err) {
    logger.error(`Lead Capture Error: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to capture lead.' });
  }
});

/**
 * GET /api/admin/leads
 * List abandoned checkouts for admin CRM.
 */
router.get('/admin/list', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, status = 'pending' } = req.query;
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 20;
    const offsetNum = (pageNum - 1) * limitNum;

    const [leads] = await db.query(
      `SELECT * FROM abandoned_checkouts 
       WHERE status = ? 
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      [status, limitNum, offsetNum]
    );

    const [total] = await db.query(
      'SELECT COUNT(*) as count FROM abandoned_checkouts WHERE status = ?',
      [status]
    );

    res.json({
      success: true,
      leads,
      pagination: {
        total: total[0].count,
        page: parseInt(page),
        pages: Math.ceil(total[0].count / parseInt(limit))
      }
    });
  } catch (err) {
    logger.error(`Admin Lead List Error: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to fetch leads.' });
  }
});

export default router;
