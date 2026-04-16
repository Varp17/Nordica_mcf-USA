import db from '../config/database.js';
import { v4 as uuidv4 } from 'uuid';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { calculateTax } from './taxService.js';

/**
 * ── Invoice Service ────────────────────────────────────────────────────────────
 * Handles record keeping and PDF generation for orders.
 */

/**
 * Generate a sequential invoice number (e.g., INV-2026-04-00001)
 */
export async function generateInvoiceNumber() {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    
    await connection.execute(
      `INSERT INTO invoice_sequences (year, month, last_number) 
       VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE last_number = last_number + 1`, 
      [year, month]
    );
    
    const [rows] = await connection.execute(
      `SELECT last_number FROM invoice_sequences WHERE year = ? AND month = ?`, 
      [year, month]
    );
    
    const num = rows[0].last_number;
    const invoiceNumber = `INV-${year}-${String(month).padStart(2, '0')}-${String(num).padStart(5, '0')}`;
    
    await connection.commit();
    return invoiceNumber;
  } catch (err) {
    if (connection) await connection.rollback();
    throw err;
  } finally {
    if (connection) connection.release();
  }
}

/**
 * Create Invoice record and generate PDF from an order
 */
export async function createInvoiceFromOrder(orderId) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const sql = `
      SELECT o.*, u.email as user_email, u.first_name as user_fname, u.last_name as user_lname 
      FROM orders o 
      LEFT JOIN users u ON o.user_id = u.id 
      WHERE o.id = ? FOR UPDATE`;
      
    const [orders] = await connection.execute(sql, [orderId]);
    if (!orders.length) throw new Error('Order not found');
    const order = orders[0];

    const [items] = await connection.execute(`SELECT * FROM order_items WHERE order_id = ?`, [orderId]);
    
    const subtotal = parseFloat(order.subtotal || 0);
    const shipping = parseFloat(order.shipping_cost || 0);
    const country  = order.country || 'US';
    const state    = order.shipping_state || order.shipping_province || '';

    // EDGE CASE #81: Using centralized tax calculation
    const taxInfo = await calculateTax(subtotal, country, state);
    const total = parseFloat((subtotal + taxInfo.amount + shipping).toFixed(2));
    
    const invId = uuidv4();
    const invNum = await generateInvoiceNumber();

    await connection.execute(
      `INSERT INTO invoices (
        id, order_id, user_id, invoice_number, status, 
        subtotal, tax_amount, shipping_amount, total_amount, 
        tax_rate, tax_type, currency, billing_name, billing_email, 
        shipping_address, payment_method, payment_status, payment_reference, invoice_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`, 
      [
        invId, orderId, order.user_id, invNum, 'issued', 
        subtotal, taxInfo.amount, shipping, total, 
        taxInfo.rate, taxInfo.label, order.currency || 'USD', 
        (`${order.shipping_first_name} ${order.shipping_last_name}`).trim() || 'Valued Customer', 
        order.user_email || order.customer_email || '',
        JSON.stringify({
          address1: order.shipping_address1, address2: order.shipping_address2,
          city: order.shipping_city, state: state, country: country, zip: order.shipping_zip || order.shipping_postal_code
        }),
        order.payment_method, order.payment_status, order.payment_reference
      ]
    );

    // Items
    for (let i = 0; i < items.length; i++) {
        const itm = items[i];
        const itmSub = parseFloat((itm.unit_price * itm.quantity).toFixed(2));
        const itmTax = parseFloat((itmSub * taxInfo.rate).toFixed(2));
        await connection.execute(
          `INSERT INTO invoice_items (id, invoice_id, product_id, product_name, product_sku, unit_price, quantity, subtotal, tax_per_item, total, line_item_number) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
          [uuidv4(), invId, itm.product_id, itm.product_name, itm.sku, itm.unit_price, itm.quantity, itmSub, itmTax, itmSub + itmTax, i + 1]
        );
    }

    const fullData = { 
      ...order, invoice_number: invNum, items, tax_amount: taxInfo.amount, 
      tax_type: taxInfo.label, shipping_amount: shipping, total_amount: total,
      customer_name: (`${order.shipping_first_name} ${order.shipping_last_name}`).trim() || 'Customer',
      customer_email: order.user_email || order.customer_email
    };

    const pdfInfo = await generateInvoicePDF(fullData);
    await connection.execute(`UPDATE invoices SET pdf_url = ?, pdf_generated_at = NOW() WHERE id = ?`, [pdfInfo.url, invId]);

    await connection.commit();
    return { invoiceId: invId, invoiceNumber: invNum, pdfPath: pdfInfo.filepath, url: pdfInfo.url };
  } catch (err) {
    if (connection) await connection.rollback();
    logger.error(`Invoice Error for ${orderId}: ${err.message}`);
    throw err;
  } finally {
    if (connection) connection.release();
  }
}

export async function generateInvoicePDF(invoiceData) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const pdfDir = path.join(process.cwd(), 'uploads', 'invoices');
      if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
      const filename = `invoice-${invoiceData.invoice_number}.pdf`;
      const filepath = path.join(pdfDir, filename);
      const writeStream = fs.createWriteStream(filepath);
      
      doc.pipe(writeStream);
      doc.fontSize(20).text('Nordica Ecom', 50, 50);
      doc.text('INVOICE', 400, 50);
      doc.fontSize(10).text(`Inv #: ${invoiceData.invoice_number}`, 400, 80);
      doc.text(`Date: ${new Date().toLocaleDateString()}`, 400, 95);
      
      doc.text(`Bill To:`, 50, 150);
      doc.text(invoiceData.customer_name, 50, 165);
      doc.text(invoiceData.customer_email, 50, 180);

      doc.end();

      writeStream.on('finish', () => resolve({ filepath, filename, url: `/uploads/invoices/${filename}` }));
      writeStream.on('error', reject);
    } catch (e) { reject(e); }
  });
}

export default { createInvoiceFromOrder, generateInvoicePDF };
