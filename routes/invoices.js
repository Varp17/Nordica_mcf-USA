import express from 'express';
import db from '../config/database.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import { generateInvoiceBuffer } from '../utils/pdfGenerator.js';
import { uploadBuffer } from '../services/s3Service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// ============================================
// ADMIN STATS: GET /api/admin/invoices/stats
// ============================================
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [totalRows] = await db.execute("SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as revenue FROM invoices");
    const [unpaidRows] = await db.execute("SELECT COUNT(*) as count FROM invoices WHERE status = 'unpaid'");
    const [mcfRows] = await db.execute("SELECT COUNT(*) as count FROM invoices WHERE fulfillment_channel = 'MCF'");
    const [shippoRows] = await db.execute("SELECT COUNT(*) as count FROM invoices WHERE fulfillment_channel = 'SHIPPO'");

    res.json({
      totalInvoices: totalRows[0].count,
      totalRevenue: totalRows[0].revenue,
      unpaidInvoices: unpaidRows[0].count,
      mcfInvoices: mcfRows[0].count,
      shippoInvoices: shippoRows[0].count
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN LIST: GET /api/admin/invoices
// ============================================
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search, user_id } = req.query;

    const pageNum = parseInt(String(page), 10) || 1;
    const limitNum = parseInt(String(limit), 10) || 20;
    const offset = (pageNum - 1) * limitNum;

    let whereClause = '1=1';
    const params = [];

    if (status) {
      whereClause += ' AND i.status = ?';
      params.push(status);
    }

    if (user_id) {
      whereClause += ' AND o.user_id = ?';
      params.push(user_id);
    }

    if (search) {
      whereClause +=
        ' AND (i.invoice_number LIKE ? OR u.email LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?)';
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    const [invoices] = await db.execute(
      `SELECT i.*, 
              COALESCE(u.email, i.billing_email) as customer_email, 
              COALESCE(u.first_name, '') as first_name, 
              COALESCE(u.last_name, '') as last_name,
              i.order_id,
              (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) as item_count
       FROM invoices i
       LEFT JOIN orders o ON i.order_id = o.id
       LEFT JOIN users u ON i.user_id = u.id
       WHERE ${whereClause}
       ORDER BY i.invoice_date DESC
       LIMIT ${limitNum} OFFSET ${offset}`,
      params
    );

    const invoicesWithOrderNumber = invoices.map((inv) => ({
      ...inv,
      order_number: `ORD-${String(inv.order_id).substring(0, 8)}`,
    }));

    const [count] = await db.execute(
      `SELECT COUNT(*) as total FROM invoices i 
       LEFT JOIN orders o ON i.order_id = o.id
       LEFT JOIN users u ON o.user_id = u.id
       WHERE ${whereClause}`,
      params
    );

    const total = count[0]?.total || 0;

    res.json({
      invoices: invoicesWithOrderNumber,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('❌ Get all invoices error:', error);
    res.status(500).json({
      error: 'Failed to fetch invoices',
      details: error.message,
    });
  }
});

// GENERATE INVOICE FROM ORDER: POST /api/admin/invoices/generate/:orderId
// ============================================
router.post(
  '/generate/:orderId',
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const { orderId } = req.params;

      const [orderRows] = await db.execute("SELECT country FROM orders WHERE id = ?", [orderId]);
      if (!orderRows.length) return res.status(404).json({ error: "Order not found" });

      const country = orderRows[0].country;

      const invoiceService = (await import('../services/invoiceService.js')).default;
      let result;

      if (country === 'US') {
        result = await invoiceService.createMCFInvoice(orderId);
      } else {
        result = await invoiceService.createShippoInvoice(orderId);
      }

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      res.json({
        success: true,
        message: "Invoice generated successfully",
        invoice_number: result.invoiceNumber,
        pdf_url: result.s3Url
      });
    } catch (error) {
      console.error('❌ Manual invoice generation failed:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

// GET SINGLE INVOICE BY ID: GET /api/admin/invoices/:id
// ============================================
router.get('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const [invoices] = await db.execute(
      `SELECT i.*, 
              COALESCE(u.email, i.billing_email) as customer_email, 
              COALESCE(u.first_name, '') as first_name, 
              COALESCE(u.last_name, '') as last_name,
              i.order_id
       FROM invoices i
       LEFT JOIN users u ON i.user_id = u.id
       WHERE i.id = ?`,
      [id]
    );

    if (invoices.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invoices[0];

    // Get invoice items
    const [items] = await db.execute(
      `SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY line_item_number`,
      [id]
    );

    invoice.items = items;
    res.json(invoice);
  } catch (error) {
    console.error('❌ Get single invoice error:', error);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// GET INVOICE BY ORDER: GET /api/admin/invoices/order/:orderId
router.get(
  '/order/:orderId',
  authenticateToken,
  async (req, res) => {
    try {
      const { orderId } = req.params;

      const [invoices] = await db.execute(
        `SELECT i.*, 
                u.email as customer_email, 
                u.first_name, 
                u.last_name,
                i.order_id
         FROM invoices i
         JOIN users u ON i.user_id = u.id
         WHERE i.order_id = ?`,
        [orderId]
      );

      if (invoices.length === 0) {
        return res
          .status(404)
          .json({ error: 'Invoice not found for this order' });
      }

      const invoice = invoices[0];

      if (req.user.role !== 'admin' && invoice.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }

      invoice.order_number = `ORD-${String(invoice.order_id).substring(0, 8)}`;

      const [items] = await db.execute(
        `SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY line_item_number`,
        [invoice.id]
      );

      if (
        invoice.billing_address &&
        typeof invoice.billing_address === 'string'
      ) {
        invoice.billing_address = JSON.parse(invoice.billing_address);
      }
      if (
        invoice.shipping_address &&
        typeof invoice.shipping_address === 'string'
      ) {
        invoice.shipping_address = JSON.parse(invoice.shipping_address);
      }

      invoice.items = items;

      res.json(invoice);
    } catch (error) {
      console.error('Get invoice by order error:', error);
      res.status(500).json({ error: 'Failed to fetch invoice' });
    }
  }
);

// VIEW INVOICE PDF BY ORDER ID: GET /api/admin/invoices/order/:orderId/view
router.get('/order/:orderId/view', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const [rows] = await db.execute(
      'SELECT pdf_url FROM invoices WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
      [orderId]
    );

    if (rows.length && rows[0].pdf_url) {
      return res.redirect(rows[0].pdf_url);
    }

    // Fallback to order table's invoice_pdf_url
    const [orderRows] = await db.execute(
      'SELECT invoice_pdf_url FROM orders WHERE id = ?',
      [orderId]
    );

    if (orderRows.length && orderRows[0].invoice_pdf_url) {
      return res.redirect(orderRows[0].invoice_pdf_url);
    }

    res.status(404).send('Invoice not found for this order.');
  } catch (err) {
    console.error('View invoice by order error:', err);
    res.status(500).send('Internal server error');
  }
});

// CUSTOMER INVOICES: GET /api/admin/customers/:userId/invoices
router.get(
  '/customers/:userId/invoices',
  authenticateToken,
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { page = 1, limit = 20 } = req.query;

      if (req.user.role !== 'admin' && req.user.id !== userId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const pageNum = parseInt(String(page), 10) || 1;
      const limitNum = parseInt(String(limit), 10) || 20;
      const offset = (pageNum - 1) * limitNum;

      const [invoices] = await db.execute(
        `SELECT i.*, 
                i.order_id,
                (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) as item_count
         FROM invoices i
         WHERE i.user_id = ?
         ORDER BY i.invoice_date DESC
         LIMIT ${limitNum} OFFSET ${offset}`,
        [userId]
      );

      const invoicesWithOrderNumber = invoices.map((inv) => ({
        ...inv,
        order_number: `ORD-${String(inv.order_id).substring(0, 8)}`,
      }));

      const [count] = await db.execute(
        'SELECT COUNT(*) as total FROM invoices WHERE user_id = ?',
        [userId]
      );

      const total = count[0]?.total || 0;

      res.json({
        invoices: invoicesWithOrderNumber,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum),
        },
      });
    } catch (error) {
      console.error('Get customer invoices error:', error);
      res.status(500).json({ error: 'Failed to fetch invoices' });
    }
  }
);

// GENERATE PDF: GET /api/admin/invoices/:id/pdf
router.get('/:id/pdf', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Get full invoice data
    const [invoices] = await db.execute(
      `SELECT i.*, COALESCE(u.email, i.billing_email) as email, COALESCE(u.first_name, '') as first_name, COALESCE(u.last_name, '') as last_name
       FROM invoices i
       LEFT JOIN users u ON i.user_id = u.id
       WHERE i.id = ?`,
      [id]
    );

    if (invoices.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invoices[0];

    // Check authorization
    if (req.user.role !== 'admin' && invoice.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get invoice items
    const [items] = await db.execute(
      `SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY line_item_number`,
      [id]
    );

    // Parse JSON fields
    if (invoice.billing_address && typeof invoice.billing_address === 'string') {
      invoice.billing_address = JSON.parse(invoice.billing_address);
    }
    if (
      invoice.shipping_address &&
      typeof invoice.shipping_address === 'string'
    ) {
      invoice.shipping_address = JSON.parse(invoice.shipping_address);
    }

    invoice.items = items;

    // Generate PDF
    const pdfBuffer = await generateInvoiceBuffer(invoice);

    // Upload to S3
    const s3Key = `invoices/invoice_${id}.pdf`;
    const s3Url = await uploadBuffer(pdfBuffer, s3Key, "application/pdf");

    // Update invoice with PDF URL
    await db.execute(
      `UPDATE invoices SET pdf_url = ?, pdf_generated_at = NOW() WHERE id = ?`,
      [s3Url, id]
    );

    // Log PDF generation
    await db.execute(
      `INSERT INTO invoice_audit_log (invoice_id, action, performed_by, ip_address)
       VALUES (?, 'pdf_generated', ?, ?)`,
      [id, req.user.id, req.ip]
    );

    // Send PDF file
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Invoice-${invoice.invoice_number}.pdf"`
    );

    res.send(pdfBuffer);
  } catch (error) {
    console.error('Generate PDF error:', error);
    res
      .status(500)
      .json({ error: 'Failed to generate PDF', details: error.message });
  }
});

// UPDATE INVOICE STATUS: PUT /api/admin/invoices/:id/status
router.put(
  '/:id/status',
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, payment_status } = req.body;

      const validStatuses = ['draft', 'issued', 'paid', 'cancelled', 'refunded'];
      const validPaymentStatuses = ['pending', 'paid', 'failed', 'refunded'];

      if (status && !validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }

      if (
        payment_status &&
        !validPaymentStatuses.includes(payment_status)
      ) {
        return res.status(400).json({ error: 'Invalid payment status' });
      }

      const updates = [];
      const params = [];

      if (status) {
        updates.push('status = ?');
        params.push(status);
      }

      if (payment_status) {
        updates.push('payment_status = ?');
        params.push(payment_status);

        if (payment_status === 'paid') {
          updates.push('paid_at = NOW()');
        }
      }

      params.push(id);

      const [result] = await db.execute(
        `UPDATE invoices SET ${updates.join(
          ', '
        )}, updated_at = NOW() WHERE id = ?`,
        params
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Invoice not found' });
      }

      // Log status change
      await db.execute(
        `INSERT INTO invoice_audit_log (invoice_id, action, performed_by, new_status, ip_address)
         VALUES (?, 'status_updated', ?, ?, ?)`,
        [id, req.user.id, status || payment_status, req.ip]
      );

      res.json({ message: 'Invoice status updated successfully' });
    } catch (error) {
      console.error('Update invoice status error:', error);
      res.status(500).json({ error: 'Failed to update invoice status' });
    }
  }
);

// DELETE/CANCEL INVOICE: DELETE /api/admin/invoices/:id
router.delete(
  '/:id',
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;

      // Soft delete - mark as cancelled
      const [result] = await db.execute(
        `UPDATE invoices SET status = 'cancelled', updated_at = NOW() WHERE id = ?`,
        [id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Invoice not found' });
      }

      // Log cancellation
      await db.execute(
        `INSERT INTO invoice_audit_log (invoice_id, action, performed_by, new_status, ip_address)
         VALUES (?, 'cancelled', ?, 'cancelled', ?)`,
        [id, req.user.id, req.ip]
      );

      res.json({ message: 'Invoice cancelled successfully' });
    } catch (error) {
      console.error('Cancel invoice error:', error);
      res.status(500).json({ error: 'Failed to cancel invoice' });
    }
  }
);

// INVOICE ANALYTICS: GET /api/admin/analytics/invoices
router.get(
  '/analytics/invoices',
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      // Total revenue
      const [revenue] = await db.execute(
        `SELECT 
          SUM(total_amount) as total_revenue,
          SUM(tax_amount) as total_tax,
          COUNT(*) as total_invoices,
          AVG(total_amount) as avg_invoice_value
         FROM invoices
         WHERE status IN ('issued', 'paid')`
      );

      // Revenue by status
      const [byStatus] = await db.execute(
        `SELECT status, COUNT(*) as count, SUM(total_amount) as revenue
         FROM invoices
         GROUP BY status`
      );

      // Monthly revenue
      const [monthly] = await db.execute(
        `SELECT 
          DATE_FORMAT(invoice_date, '%Y-%m') as month,
          COUNT(*) as invoice_count,
          SUM(total_amount) as revenue
         FROM invoices
         WHERE invoice_date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
         GROUP BY DATE_FORMAT(invoice_date, '%Y-%m')
         ORDER BY month`
      );

      // Payment method breakdown
      const [byPaymentMethod] = await db.execute(
        `SELECT payment_method, COUNT(*) as count, SUM(total_amount) as revenue
         FROM invoices
         WHERE payment_method IS NOT NULL
         GROUP BY payment_method`
      );

      res.json({
        summary: revenue[0],
        by_status: byStatus,
        monthly_revenue: monthly,
        by_payment_method: byPaymentMethod,
      });
    } catch (error) {
      console.error('Invoice analytics error:', error);
      res.status(500).json({ error: 'Failed to fetch analytics' });
    }
  }
);

// ============================================
// SECURE VIEW/DOWNLOAD: GET /api/invoices/:id/view OR /api/admin/invoices/:id/view
// ============================================
router.get('/:id/view', authenticateToken, async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT pdf_url, user_id FROM invoices WHERE id = ?", [req.params.id]);
    if (!rows.length || !rows[0].pdf_url) return res.status(404).json({ error: "Invoice PDF not found." });

    if (req.user.role !== 'admin' && rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: "Access denied." });
    }

    if (rows[0].pdf_url.startsWith('http')) return res.redirect(rows[0].pdf_url);
    res.sendFile(path.resolve(rows[0].pdf_url));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET INVOICE VIEW BY ORDER ID: GET /api/admin/invoices/order/:orderId/view
router.get('/order/:orderId/view', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const [rows] = await db.execute(
      "SELECT pdf_url, user_id FROM invoices WHERE order_id = ? ORDER BY created_at DESC LIMIT 1",
      [orderId]
    );

    if (!rows.length || !rows[0].pdf_url) {
      return res.status(404).send(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h2 style="color: #64748b;">Invoice Not Found</h2>
          <p style="color: #94a3b8;">The invoice for this order hasn't been generated yet or is still processing.</p>
          <button onclick="window.close()" style="background: #0f172a; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; margin-top: 20px;">Close Window</button>
        </div>
      `);
    }

    if (req.user.role !== 'admin' && rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: "Access denied." });
    }

    if (rows[0].pdf_url.startsWith('http')) return res.redirect(rows[0].pdf_url);
    res.sendFile(path.resolve(rows[0].pdf_url));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
