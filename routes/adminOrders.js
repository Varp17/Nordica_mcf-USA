import express from 'express';
import db from '../config/database.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import Order from '../models/Order.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * GET /api/admin/orders-manage
 * Advanced order search and filtering for admin
 */
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      search = '', 
      status, 
      payment_status, 
      fulfillment_status, 
      country,
      startDate,
      endDate,
      sort = 'created_at',
      order = 'DESC'
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const limitNum = parseInt(limit);

    let whereClauses = ['1=1'];
    let params = [];

    if (search) {
      whereClauses.push('(o.order_number LIKE ? OR o.customer_email LIKE ? OR o.shipping_first_name LIKE ? OR o.shipping_last_name LIKE ?)');
      const searchVal = `%${search}%`;
      params.push(searchVal, searchVal, searchVal, searchVal);
    }

    if (status) {
      whereClauses.push('o.status = ?');
      params.push(status);
    }

    if (payment_status) {
      whereClauses.push('o.payment_status = ?');
      params.push(payment_status);
    }

    if (fulfillment_status) {
      whereClauses.push('o.fulfillment_status = ?');
      params.push(fulfillment_status);
    }

    if (country) {
      whereClauses.push('o.country = ?');
      params.push(country.toUpperCase());
    }

    if (startDate) {
      whereClauses.push('o.created_at >= ?');
      params.push(startDate);
    }

    if (endDate) {
      whereClauses.push('o.created_at <= ?');
      params.push(endDate + ' 23:59:59');
    }

    const whereSql = whereClauses.join(' AND ');
    
    // Validate sort column to prevent injection
    const allowedSortFields = ['created_at', 'total', 'order_number', 'status', 'payment_status', 'fulfillment_status'];
    const sortField = allowedSortFields.includes(sort) ? sort : 'created_at';
    const sortOrder = (order.toUpperCase() === 'ASC') ? 'ASC' : 'DESC';

    const [orders] = await db.query(
      `SELECT o.*, u.first_name as user_first_name, u.last_name as user_last_name
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       WHERE ${whereSql}
       ORDER BY o.${sortField} ${sortOrder}
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    const [totalResult] = await db.query(
      `SELECT COUNT(*) as total FROM orders o WHERE ${whereSql}`,
      params
    );

    res.json({
      success: true,
      orders,
      pagination: {
        total: totalResult[0].total,
        page: parseInt(page),
        limit: limitNum,
        pages: Math.ceil(totalResult[0].total / limitNum)
      }
    });
  } catch (error) {
    logger.error(`Admin Order Search Error: ${error.message}`);
    res.status(500).json({ success: false, message: 'Failed to search orders', error: error.message });
  }
});

/**
 * GET /api/admin/orders-manage/export
 * Export orders as CSV download (no json2xls dependency — pure CSV)
 */
router.get('/export', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { search = '', status, payment_status, fulfillment_status, country, startDate, endDate } = req.query;

    let whereClauses = ['1=1'];
    let params = [];

    if (search) {
      whereClauses.push('(order_number LIKE ? OR customer_email LIKE ? OR shipping_first_name LIKE ? OR shipping_last_name LIKE ?)');
      const searchVal = `%${search}%`;
      params.push(searchVal, searchVal, searchVal, searchVal);
    }
    if (status) { whereClauses.push('status = ?'); params.push(status); }
    if (payment_status) { whereClauses.push('payment_status = ?'); params.push(payment_status); }
    if (fulfillment_status) { whereClauses.push('fulfillment_status = ?'); params.push(fulfillment_status); }
    if (country) { whereClauses.push('country = ?'); params.push(country.toUpperCase()); }
    if (startDate) { whereClauses.push('created_at >= ?'); params.push(startDate); }
    if (endDate) { whereClauses.push('created_at <= ?'); params.push(endDate + ' 23:59:59'); }

    const whereSql = whereClauses.join(' AND ');

    const [orders] = await db.query(
      `SELECT 
        order_number, created_at, customer_email, country, 
        total, currency, status, payment_status, fulfillment_status,
        shipping_first_name, shipping_last_name, shipping_address1, shipping_city, shipping_state, shipping_zip,
        payment_method, payment_reference, actual_shipping_cost, shipping_profit_loss
       FROM orders
       WHERE ${whereSql}
       ORDER BY created_at DESC`,
      params
    );

    // Generate CSV manually — zero external dependency
    const columns = [
      'order_number', 'created_at', 'customer_email', 'country',
      'total', 'currency', 'status', 'payment_status', 'fulfillment_status',
      'shipping_first_name', 'shipping_last_name', 'shipping_address1', 'shipping_city', 'shipping_state', 'shipping_zip',
      'payment_method', 'payment_reference', 'actual_shipping_cost', 'shipping_profit_loss'
    ];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    let csv = columns.join(',') + '\n';
    for (const row of orders) {
      csv += columns.map(col => escapeCsv(row[col])).join(',') + '\n';
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="orders_export_${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(csv);
  } catch (error) {
    logger.error(`Admin Order Export Error: ${error.message}`);
    res.status(500).json({ success: false, message: 'Failed to export orders' });
  }
});

/**
 * PATCH /api/admin/orders-manage/:id
 * Partially update order (e.g. status, notes)
 */
router.patch('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const updatedOrder = await Order.updateOrder(id, updates);
    
    if (!updatedOrder) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    res.json({ success: true, order: updatedOrder });
  } catch (error) {
    logger.error(`Admin Order Update Error: ${error.message}`);
    res.status(500).json({ success: false, message: 'Failed to update order' });
  }
});

/**
 * POST /api/admin/orders-manage/:id/refund
 * Mark order as refunded (Manual process usually, just record here)
 */
router.post('/:id/refund', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const [rows] = await db.execute('SELECT payment_status FROM orders WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Order not found' });

    await db.execute(
      `UPDATE orders SET 
        payment_status = 'refunded', 
        status = 'cancelled',
        notes = CONCAT(COALESCE(notes, ''), ?),
        updated_at = NOW() 
       WHERE id = ?`,
      [`\nRefunded on ${new Date().toISOString()}${notes ? ': ' + notes : ''}`, id]
    );

    const updated = await Order.findById(id);
    res.json({ success: true, order: updated });
  } catch (error) {
    logger.error(`Admin Order Refund Error: ${error.message}`);
    res.status(500).json({ success: false, message: 'Failed to mark as refunded' });
  }
});

export default router;
