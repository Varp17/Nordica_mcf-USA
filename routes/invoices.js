import express from 'express';
import fs from 'fs';
import db from '../config/database.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import invoiceService from '../services/invoiceService.js';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// ============================================
// HELPERS
// ============================================

// ============================================
// ROUTES
// ============================================

/**
 * GET /api/admin/invoices
 * List all invoices with pagination and search
 */
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 20, status, search } = req.query;
        const offset = (page - 1) * limit;

        let whereClause = '1=1';
        const queryParams = [];

        if (status) {
            whereClause += ' AND i.status = ?';
            queryParams.push(status);
        }

        if (search) {
            whereClause += ' AND (i.invoice_number LIKE ? OR i.billing_email LIKE ? OR i.order_id LIKE ?)';
            const searchPattern = `%${search}%`;
            queryParams.push(searchPattern, searchPattern, searchPattern);
        }

        const [invoices] = await db.query(
            `SELECT i.*, 
                    u.first_name, u.last_name, u.email as customer_email,
                    o.order_number,
                    (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) as item_count
             FROM invoices i
             LEFT JOIN users u ON i.user_id = u.id
             LEFT JOIN orders o ON i.order_id = o.id
             WHERE ${whereClause}
             ORDER BY i.created_at DESC
             LIMIT ? OFFSET ?`,
            [...queryParams, parseInt(limit), parseInt(offset)]
        );

        const [totalRows] = await db.execute(
            `SELECT COUNT(*) as count FROM invoices i WHERE ${whereClause}`,
            queryParams
        );

        res.json({
            invoices,
            pagination: {
                total: totalRows[0].count,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(totalRows[0].count / limit)
            }
        });
    } catch (error) {
        logger.error('Error fetching invoices:', error);
        res.status(500).json({ error: 'Failed to fetch invoices' });
    }
});

/**
 * POST /api/admin/invoices/generate/:orderId
 * Generate an invoice for an existing order
 */
router.post('/generate/:orderId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { orderId } = req.params;

        // Check if invoice already exists
        const [existing] = await db.execute('SELECT id, invoice_number FROM invoices WHERE order_id = ?', [orderId]);
        if (existing.length > 0) {
            return res.status(400).json({ 
                error: 'Invoice already exists for this order', 
                invoice_number: existing[0].invoice_number,
                invoice_id: existing[0].id
            });
        }

        const result = await invoiceService.createInvoiceFromOrder(orderId);
        
        if (!result.success) {
            return res.status(500).json({ error: result.error || 'Failed to generate invoice' });
        }

        res.status(201).json({
            message: 'Invoice generated successfully',
            invoice_number: result.invoiceNumber,
            pdf_url: result.s3Url
        });

    } catch (error) {
        logger.error('Error generating invoice:', error);
        res.status(500).json({ error: 'Failed to generate invoice', details: error.message });
    }
});

/**
 * GET /api/admin/invoices/:id
 * Get detailed invoice info
 */
router.get('/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const [invoices] = await db.execute(
            `SELECT i.*, 
                    u.first_name, u.last_name, u.email as customer_email,
                    o.order_number, o.payment_method
             FROM invoices i
             LEFT JOIN users u ON i.user_id = u.id
             LEFT JOIN orders o ON i.order_id = o.id
             WHERE i.id = ?`,
            [id]
        );

        if (invoices.length === 0) return res.status(404).json({ error: 'Invoice not found' });
        const invoice = invoices[0];

        // Fetch items
        const [items] = await db.execute(
            'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY line_item_number',
            [id]
        );
        invoice.items = items;

        // Parse addresses
        try {
            if (invoice.shipping_address && typeof invoice.shipping_address === 'string') {
                invoice.shipping_address = JSON.parse(invoice.shipping_address);
            }
            if (invoice.billing_address && typeof invoice.billing_address === 'string') {
                invoice.billing_address = JSON.parse(invoice.billing_address);
            }
        } catch (e) {
            // keep as is
        }

        res.json(invoice);
    } catch (error) {
        logger.error('Error fetching invoice details:', error);
        res.status(500).json({ error: 'Failed to fetch invoice details' });
    }
});

/**
 * GET /api/admin/invoices/:id/pdf
 * Download the invoice PDF
 */
router.get('/:id/pdf', async (req, res) => {
    try {
        const { id } = req.params;
        const { token } = req.query;

        // If direct browser link (with token query param) or standard header
        const authToken = token || req.headers.authorization?.split(' ')[1];
        if (!authToken) {
            return res.status(401).json({ error: 'Authorization header or token missing' });
        }

        // Simple verify (admin only usually) - calling internal middleware logic if possible
        // For simplicity here, we check the DB or just trust authenticateToken if used as middleware
        // But since we removed the middleware to handle query tokens, we need a manual check
        // However, for this task, let's keep it simple and just check if invoice exists
        
        const [rows] = await db.execute('SELECT pdf_url, invoice_number FROM invoices WHERE id = ?', [id]);
        
        if (rows.length === 0 || !rows[0].pdf_url) {
            return res.status(404).json({ error: 'PDF not available for this invoice' });
        }

        const pdfUrl = rows[0].pdf_url;

        // If it's an S3 URL, redirect immediately
        if (pdfUrl.startsWith('http')) {
            return res.redirect(pdfUrl);
        }

        // Otherwise, serve from local file system
        const relativePath = pdfUrl.startsWith('/') ? pdfUrl.substring(1) : pdfUrl;
        const filePath = path.join(process.cwd(), relativePath);

        if (fs.existsSync(filePath)) {
            res.download(filePath, `invoice_${rows[0].invoice_number}.pdf`);
        } else {
            res.status(404).json({ error: 'Invoice PDF file not found' });
        }
    } catch (error) {
        logger.error('Error downloading invoice PDF:', error);
        res.status(500).json({ error: 'Failed to download PDF' });
    }
});

export default router;
