import express from 'express';
import db from '../config/database.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// ============================================
// TAX CALCULATION HELPERS
// ============================================

async function getTaxRate(country, stateProvince) {
  const [rates] = await db.execute(
    `SELECT * FROM tax_rates 
     WHERE country = ? 
     AND state_province = ? 
     AND is_active = TRUE 
     AND (effective_from IS NULL OR effective_from <= CURDATE())
     AND (effective_to IS NULL OR effective_to >= CURDATE())
     ORDER BY tax_type`,
    [country, stateProvince]
  );

  return rates;
}

function calculateUSTax(subtotal, stateCode) {
  return async function () {
    const rates = await getTaxRate('US', stateCode);

    if (rates.length === 0) {
      return {
        tax_amount: 0,
        tax_rate: 0,
        tax_type: 'sales_tax',
        tax_jurisdiction: stateCode,
        tax_breakdown: [],
      };
    }

    const rate = rates[0];
    const taxAmount = (subtotal * rate.tax_rate) / 100;

    return {
      tax_amount: Math.round(taxAmount * 100) / 100,
      tax_rate: rate.tax_rate,
      tax_type: rate.tax_type,
      tax_jurisdiction: stateCode,
      tax_breakdown: [
        {
          type: rate.tax_type,
          rate: rate.tax_rate,
          amount: Math.round(taxAmount * 100) / 100,
        },
      ],
    };
  };
}

function calculateCanadaTax(subtotal, provinceCode) {
  return async function () {
    const rates = await getTaxRate('CA', provinceCode);

    if (rates.length === 0) {
      return {
        tax_amount: 0,
        tax_rate: 0,
        tax_type: 'gst',
        tax_jurisdiction: provinceCode,
        tax_breakdown: [],
      };
    }

    let totalTax = 0;
    let totalRate = 0;
    const breakdown = [];

    const hst = rates.find((r) => r.tax_type === 'hst');
    if (hst) {
      const taxAmount = (subtotal * hst.tax_rate) / 100;
      return {
        tax_amount: Math.round(taxAmount * 100) / 100,
        tax_rate: hst.tax_rate,
        tax_type: 'hst',
        tax_jurisdiction: provinceCode,
        tax_breakdown: [
          {
            type: 'hst',
            rate: hst.tax_rate,
            amount: Math.round(taxAmount * 100) / 100,
          },
        ],
      };
    }

    for (const rate of rates) {
      const taxAmount = (subtotal * rate.tax_rate) / 100;
      totalTax += taxAmount;
      totalRate += rate.tax_rate;

      breakdown.push({
        type: rate.tax_type,
        rate: rate.tax_rate,
        amount: Math.round(taxAmount * 100) / 100,
      });
    }

    return {
      tax_amount: Math.round(totalTax * 100) / 100,
      tax_rate: Math.round(totalRate * 100) / 100,
      tax_type: rates.map((r) => r.tax_type).join('+'),
      tax_jurisdiction: provinceCode,
      tax_breakdown: breakdown,
    };
  };
}

async function calculateTax(subtotal, country, stateProvince) {
  if (country === 'US') {
    return await calculateUSTax(subtotal, stateProvince)();
  } else if (country === 'CA') {
    return await calculateCanadaTax(subtotal, stateProvince)();
  }

  return {
    tax_amount: 0,
    tax_rate: 0,
    tax_type: 'none',
    tax_jurisdiction: stateProvince,
    tax_breakdown: [],
  };
}

// ============================================
// INVOICE NUMBER GENERATION
// ============================================

async function generateInvoiceNumber() {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;
    const prefix = 'INV';

    await connection.execute(
      `INSERT INTO invoice_sequences (year, month, last_number, prefix)
       VALUES (?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE last_number = last_number + 1`,
      [currentYear, currentMonth, prefix]
    );

    const [rows] = await connection.execute(
      `SELECT last_number FROM invoice_sequences 
       WHERE year = ? AND month = ?`,
      [currentYear, currentMonth]
    );

    const nextNumber = rows[0].last_number;

    const invoiceNumber = `${prefix}-${currentYear}-${String(currentMonth).padStart(
      2,
      '0'
    )}-${String(nextNumber).padStart(5, '0')}`;

    await connection.commit();
    return invoiceNumber;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// ============================================
// PDF GENERATION HELPER
// ============================================

function formatDate(date) {
  if (!date) return 'N/A';
  const d = new Date(date);
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

async function generateInvoicePDF(invoiceData) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: `Invoice ${invoiceData.invoice_number}`,
          Author: 'Detail Gurdz',
          Subject: 'Invoice',
        },
      });

      const pdfDir = path.join(process.cwd(), 'uploads', 'invoices');

      if (!fs.existsSync(pdfDir)) {
        fs.mkdirSync(pdfDir, { recursive: true });
      }

      const filename = `invoice-${invoiceData.invoice_number}.pdf`;
      const filepath = path.join(pdfDir, filename);
      const writeStream = fs.createWriteStream(filepath);

      doc.pipe(writeStream);

      const primaryColor = '#2563eb';
      const textColor = '#1f2937';
      const lightGray = '#f3f4f6';
      const borderColor = '#e5e7eb';

      // HEADER
      doc.fontSize(24).fillColor(primaryColor).text('Detail Gurdz', 50, 50);

      doc
        .fontSize(10)
        .fillColor(textColor)
        .text('123 Business St', 50, 80)
        .text('City, State 12345', 50, 95)
        .text('Phone: (555) 123-4567', 50, 110)
        .text('Email: billing@Detail Guardz.com', 50, 125);

      doc
        .fontSize(28)
        .fillColor(primaryColor)
        .text('INVOICE', 350, 50, { align: 'right' });

      doc
        .fontSize(10)
        .fillColor(textColor)
        .text(`Invoice #: ${invoiceData.invoice_number}`, 350, 85, {
          align: 'right',
        })
        .text(`Invoice Date: ${formatDate(invoiceData.invoice_date)}`, 350, 100, {
          align: 'right',
        })
        .text(`Due Date: ${formatDate(invoiceData.due_date)}`, 350, 115, {
          align: 'right',
        });

      const statusY = 135;
      const statusText = String(invoiceData.status || '').toUpperCase();
      const statusColor =
        invoiceData.status === 'paid'
          ? '#10b981'
          : invoiceData.status === 'cancelled'
          ? '#ef4444'
          : '#f59e0b';

      doc.rect(480, statusY, 60, 20).fillAndStroke(statusColor, statusColor);

      doc
        .fontSize(9)
        .fillColor('#ffffff')
        .text(statusText, 480, statusY + 5, { width: 60, align: 'center' });

      // BILL TO / SHIP TO
      let currentY = 180;

      doc.fontSize(11).fillColor(primaryColor).text('BILL TO:', 50, currentY);

      doc
        .fontSize(10)
        .fillColor(textColor)
        .text(invoiceData.billing_name || '', 50, currentY + 20)
        .text(invoiceData.billing_email || '', 50, currentY + 35);

      if (invoiceData.billing_address) {
        const addr = invoiceData.billing_address;
        doc
          .text(addr.address || addr.street1 || '', 50, currentY + 50)
          .text(
            `${addr.city || ''}, ${
              addr.state || addr.province || ''
            } ${addr.zip || addr.postal_code || ''}`,
            50,
            currentY + 65
          )
          .text(addr.country || '', 50, currentY + 80);
      }

      doc.fontSize(11).fillColor(primaryColor).text('SHIP TO:', 320, currentY);

      if (invoiceData.shipping_address) {
        const ship = invoiceData.shipping_address;
        doc
          .fontSize(10)
          .fillColor(textColor)
          .text(ship.name || invoiceData.billing_name || '', 320, currentY + 20)
          .text(ship.address || ship.street1 || '', 320, currentY + 35)
          .text(
            `${ship.city || ''}, ${
              ship.state || ship.province || ''
            } ${ship.zip || ship.postal_code || ''}`,
            320,
            currentY + 50
          )
          .text(ship.country || '', 320, currentY + 65);
      }

      currentY += 120;

      // ITEMS TABLE HEADER
      doc.rect(50, currentY, 495, 25).fill(lightGray);

      doc
        .fontSize(10)
        .fillColor(textColor)
        .text('Item', 60, currentY + 8)
        .text('Qty', 320, currentY + 8, { width: 40, align: 'center' })
        .text('Price', 370, currentY + 8, { width: 60, align: 'right' })
        .text('Tax', 440, currentY + 8, { width: 45, align: 'right' })
        .text('Total', 495, currentY + 8, { width: 45, align: 'right' });

      currentY += 30;

      // ITEMS
      (invoiceData.items || []).forEach((item, index) => {
        if (currentY > 700) {
          doc.addPage();
          currentY = 50;
        }

        const rowHeight = 30;

        if (index % 2 === 0) {
          doc.rect(50, currentY - 5, 495, rowHeight).fill('#fafafa');
        }

        doc.fontSize(9).fillColor(textColor);

        let itemText = item.product_name;
        if (item.color_name) itemText += `\n(${item.color_name})`;

        doc.text(itemText, 60, currentY, { width: 250 });
        doc.text(String(item.quantity), 320, currentY, {
          width: 40,
          align: 'center',
        });
        doc.text(`$${parseFloat(item.unit_price).toFixed(2)}`, 370, currentY, {
          width: 60,
          align: 'right',
        });
        doc.text(`$${parseFloat(item.tax_per_item || 0).toFixed(2)}`, 440, currentY, {
          width: 45,
          align: 'right',
        });
        doc.text(`$${parseFloat(item.total).toFixed(2)}`, 495, currentY, {
          width: 45,
          align: 'right',
        });

        currentY += rowHeight;

        doc
          .moveTo(50, currentY)
          .lineTo(545, currentY)
          .strokeColor(borderColor)
          .stroke();
      });

      currentY += 20;

      // TOTALS
      const totalsX = 350;
      const labelX = totalsX;
      const amountX = totalsX + 145;

      doc.fontSize(10).fillColor(textColor);

      doc
        .text('Subtotal:', labelX, currentY)
        .text(
          `$${parseFloat(invoiceData.subtotal).toFixed(2)}`,
          amountX,
          currentY,
          { width: 45, align: 'right' }
        );
      currentY += 20;

      if (invoiceData.discount_amount > 0) {
        doc
          .text('Discount:', labelX, currentY)
          .fillColor('#ef4444')
          .text(
            `-$${parseFloat(invoiceData.discount_amount).toFixed(2)}`,
            amountX,
            currentY,
            { width: 45, align: 'right' }
          )
          .fillColor(textColor);

        if (invoiceData.discount_code) {
          doc
            .fontSize(8)
            .fillColor('#6b7280')
            .text(`(${invoiceData.discount_code})`, labelX, currentY + 12);
          doc.fontSize(10);
        }
        currentY += 20;
      }

      if (invoiceData.shipping_amount > 0) {
        doc
          .text('Shipping:', labelX, currentY)
          .text(
            `$${parseFloat(invoiceData.shipping_amount).toFixed(2)}`,
            amountX,
            currentY,
            { width: 45, align: 'right' }
          );
        currentY += 20;
      }

      doc
        .text(
          `Tax (${invoiceData.tax_type || 'Sales Tax'}):`,
          labelX,
          currentY
        )
        .text(
          `$${parseFloat(invoiceData.tax_amount).toFixed(2)}`,
          amountX,
          currentY,
          { width: 45, align: 'right' }
        );

      if (invoiceData.tax_rate) {
        doc
          .fontSize(8)
          .fillColor('#6b7280')
          .text(
            `(${parseFloat(invoiceData.tax_rate).toFixed(2)}%)`,
            labelX,
            currentY + 12
          );
        doc.fontSize(10);
      }

      currentY += 30;

      doc
        .rect(labelX - 10, currentY - 5, 205, 30)
        .fillAndStroke(primaryColor, primaryColor);

      doc
        .fontSize(12)
        .fillColor('#ffffff')
        .text('TOTAL:', labelX, currentY + 5)
        .text(
          `$${parseFloat(invoiceData.total_amount).toFixed(2)}`,
          amountX,
          currentY + 5,
          { width: 45, align: 'right' }
        );

      currentY += 50;

      // PAYMENT INFO
      doc
        .fontSize(11)
        .fillColor(primaryColor)
        .text('PAYMENT INFORMATION', 50, currentY);

      currentY += 20;

      doc
        .fontSize(9)
        .fillColor(textColor)
        .text(
          `Payment Method: ${invoiceData.payment_method || 'N/A'}`,
          50,
          currentY
        )
        .text(
          `Payment Status: ${invoiceData.payment_status || 'pending'}`,
          50,
          currentY + 15
        );

      if (invoiceData.payment_reference) {
        doc.text(
          `Transaction ID: ${invoiceData.payment_reference}`,
          50,
          currentY + 30
        );
      }

      if (invoiceData.paid_at) {
        doc.text(`Paid Date: ${formatDate(invoiceData.paid_at)}`, 50, currentY + 45);
      }

      // FOOTER
      const footerY = 750;

      doc
        .moveTo(50, footerY)
        .lineTo(545, footerY)
        .strokeColor(borderColor)
        .stroke();

      doc
        .fontSize(8)
        .fillColor('#6b7280')
        .text('Thank you for your business!', 50, footerY + 10)
        .text(
          'If you have any questions, please contact us at support@detailguradz.com',
          50,
          footerY + 25
        );

      const pages = doc.bufferedPageRange();
      for (let i = 0; i < pages.count; i++) {
        doc.switchToPage(i);
        doc
          .fontSize(8)
          .fillColor('#9ca3af')
          .text(`Page ${i + 1} of ${pages.count}`, 50, 770, {
            align: 'right',
          });
      }

      doc.end();

      writeStream.on('finish', () => {
        resolve({
          filepath,
          filename,
          url: `/uploads/invoices/${filename}`,
        });
      });

      writeStream.on('error', reject);
    } catch (error) {
      reject(error);
    }
  });
}

// ============================================
// ROUTES
// ============================================

// ADMIN LIST: GET /api/admin/invoices
router.get('/invoices', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search, user_id } = req.query;

    console.log('📊 GET /invoices request:', {
      page,
      limit,
      status,
      search,
      user_id,
    });

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
              u.email as customer_email, 
              u.first_name, 
              u.last_name,
              i.order_id,
              (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) as item_count
       FROM invoices i
       JOIN orders o ON i.order_id = o.id
       JOIN users u ON o.user_id = u.id
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
       JOIN orders o ON i.order_id = o.id
       JOIN users u ON o.user_id = u.id
       WHERE ${whereClause}`,
      params
    );

    const total = count[0]?.total || 0;

    console.log('✅ Found', invoices.length, 'invoices, total:', total);

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
router.post(
  '/invoices/generate/:orderId',
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      const { orderId } = req.params;

      // Check if invoice already exists
      const [existing] = await connection.execute(
        'SELECT id FROM invoices WHERE order_id = ?',
        [orderId]
      );

      if (existing.length > 0) {
        await connection.rollback();
        return res.status(400).json({
          error: 'Invoice already exists for this order',
          invoice_id: existing[0].id,
        });
      }

      // Get order details with items
      const [orders] = await connection.execute(
        `SELECT o.*, u.email, u.first_name, u.last_name, u.phone_number
         FROM orders o
         JOIN users u ON o.user_id = u.id
         WHERE o.id = ?`,
        [orderId]
      );

      if (orders.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = orders[0];

      // Get order items
      const [orderItems] = await connection.execute(
        `SELECT oi.*, p.name, p.sku, p.description, p.image_url,
                cv.color_name, cv.color_code
         FROM order_items oi
         JOIN products p ON oi.product_id = p.id
         LEFT JOIN product_color_variants cv ON oi.color_variant_id = cv.id
         WHERE oi.order_id = ?`,
        [orderId]
      );

      // Parse shipping address
      let shippingAddress = {};
      try {
        shippingAddress =
          typeof order.shipping_address === 'string'
            ? JSON.parse(order.shipping_address)
            : order.shipping_address;
      } catch (e) {
        console.error('Error parsing shipping address:', e);
      }

      // Calculate subtotal from items
      let subtotal = 0;
      orderItems.forEach((item) => {
        subtotal += parseFloat(item.price_at_purchase) * item.quantity;
      });

      // Get country and state/province from shipping address
      const country = shippingAddress.country || 'US';
      const stateProvince =
        shippingAddress.state || shippingAddress.province || 'CA';

      // Calculate tax
      const taxInfo = await calculateTax(subtotal, country, stateProvince);

      // Calculate discount (if any)
      const discountAmount = parseFloat(req.body.discount_amount || 0);
      const discountCode = req.body.discount_code || null;

      // Calculate shipping (get from order or request)
      const shippingAmount = parseFloat(
        order.shipping_cost || req.body.shipping_amount || 0
      );

      // Calculate total
      const totalAmount =
        subtotal - discountAmount + taxInfo.tax_amount + shippingAmount;

      // Generate invoice number
      const invoiceNumber = await generateInvoiceNumber();

      // Create invoice
      const invoiceId = uuidv4();
      const invoiceDate = new Date();
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 30); // 30 days from now

      await connection.execute(
        `INSERT INTO invoices (
          id, invoice_number, order_id, user_id,
          status, subtotal, tax_amount, discount_amount, shipping_amount, total_amount,
          tax_rate, tax_type, tax_jurisdiction, currency,
          billing_name, billing_email, billing_phone, billing_address, shipping_address,
          payment_method, payment_status, payment_reference,
          discount_code, invoice_date, due_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceId,
          invoiceNumber,
          orderId,
          order.user_id,
          'issued',
          subtotal,
          taxInfo.tax_amount,
          discountAmount,
          shippingAmount,
          totalAmount,
          taxInfo.tax_rate,
          taxInfo.tax_type,
          taxInfo.tax_jurisdiction,
          'USD', // or get from order/request
          `${order.first_name} ${order.last_name}`,
          order.email,
          order.phone_number,
          JSON.stringify(shippingAddress), // Using shipping as billing for now
          JSON.stringify(shippingAddress),
          order.payment_method || 'credit_card',
          order.payment_status || 'paid',
          order.payment_reference || null,
          discountCode,
          invoiceDate,
          dueDate,
        ]
      );

      // Create invoice items
      for (let i = 0; i < orderItems.length; i++) {
        const item = orderItems[i];
        const itemSubtotal =
          parseFloat(item.price_at_purchase) * item.quantity;
        const itemTax = (itemSubtotal * taxInfo.tax_rate) / 100;
        const itemTotal = itemSubtotal + itemTax;

        await connection.execute(
          `INSERT INTO invoice_items (
            id, invoice_id, product_id, product_name, product_sku, product_description, product_image_url,
            color_variant_id, color_name, color_code,
            unit_price, quantity, subtotal, tax_per_item, total,
            is_taxable, tax_rate, line_item_number
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            uuidv4(),
            invoiceId,
            item.product_id,
            item.name,
            item.sku,
            item.description,
            item.image_url,
            item.color_variant_id,
            item.color_name,
            item.color_code,
            item.price_at_purchase,
            item.quantity,
            itemSubtotal,
            itemTax,
            itemTotal,
            true,
            taxInfo.tax_rate,
            i + 1,
          ]
        );
      }

      // Log invoice creation
      await connection.execute(
        `INSERT INTO invoice_audit_log (invoice_id, action, performed_by, new_status, ip_address)
         VALUES (?, 'created', ?, 'issued', ?)`,
        [invoiceId, req.user.id, req.ip]
      );

      await connection.commit();

      res.status(201).json({
        message: 'Invoice generated successfully',
        invoice_id: invoiceId,
        invoice_number: invoiceNumber,
        total_amount: totalAmount,
      });
    } catch (error) {
      await connection.rollback();
      console.error('Generate invoice error:', error);
      res.status(500).json({
        error: 'Failed to generate invoice',
        details: error.message,
      });
    } finally {
      connection.release();
    }
  }
);

// GET SINGLE INVOICE BY ID: GET /api/admin/invoices/:id
router.get('/invoices/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const [invoices] = await db.execute(
      `SELECT i.*, 
              u.email as customer_email, 
              u.first_name, 
              u.last_name,
              i.order_id
       FROM invoices i
       JOIN users u ON i.user_id = u.id
       WHERE i.id = ?`,
      [id]
    );

    if (invoices.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invoices[0];

    if (req.user.role !== 'admin' && invoice.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    invoice.order_number = `ORD-${String(invoice.order_id).substring(0, 8)}`;

    const [items] = await db.execute(
      `SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY line_item_number`,
      [id]
    );

    if (invoice.billing_address && typeof invoice.billing_address === 'string') {
      invoice.billing_address = JSON.parse(invoice.billing_address);
    }
    if (invoice.shipping_address && typeof invoice.shipping_address === 'string') {
      invoice.shipping_address = JSON.parse(invoice.shipping_address);
    }

    invoice.items = items;

    res.json(invoice);
  } catch (error) {
    console.error('Get invoice error:', error);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// GET INVOICE BY ORDER: GET /api/admin/invoices/order/:orderId
router.get(
  '/invoices/order/:orderId',
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
router.get('/invoices/:id/pdf', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Get full invoice data
    const [invoices] = await db.execute(
      `SELECT i.*, u.email, u.first_name, u.last_name
       FROM invoices i
       JOIN users u ON i.user_id = u.id
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
    const pdfInfo = await generateInvoicePDF(invoice);

    // Update invoice with PDF URL
    await db.execute(
      `UPDATE invoices SET pdf_url = ?, pdf_generated_at = NOW() WHERE id = ?`,
      [pdfInfo.url, id]
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
      `attachment; filename="${pdfInfo.filename}"`
    );

    const fileStream = fs.createReadStream(pdfInfo.filepath);
    fileStream.pipe(res);
  } catch (error) {
    console.error('Generate PDF error:', error);
    res
      .status(500)
      .json({ error: 'Failed to generate PDF', details: error.message });
  }
});

// UPDATE INVOICE STATUS: PUT /api/admin/invoices/:id/status
router.put(
  '/invoices/:id/status',
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
  '/invoices/:id',
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

export default router;
