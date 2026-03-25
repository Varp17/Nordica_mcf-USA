import db from '../config/database.js';
import { v4 as uuidv4 } from 'uuid';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

export async function getTaxRate(country, stateProvince) {
  const [rates] = await db.query(
    `SELECT * FROM tax_rates WHERE country = ? AND state_province = ? AND is_active = TRUE ORDER BY tax_type`,
    [country, stateProvince]
  );
  return rates;
}

export async function calculateTax(subtotal, country, stateProvince) {
  const rates = await getTaxRate(country, stateProvince);
  if (rates.length === 0) {
    return { tax_amount: 0, tax_rate: 0, tax_type: 'none', tax_jurisdiction: stateProvince, tax_breakdown: [] };
  }
  let totalTax = 0, totalRate = 0;
  const breakdown = [];
  const hst = rates.find((r) => r.tax_type === 'hst');
  if (hst) {
    const taxAmount = (subtotal * hst.tax_rate) / 100;
    return { tax_amount: Math.round(taxAmount * 100) / 100, tax_rate: hst.tax_rate, tax_type: 'hst', tax_jurisdiction: stateProvince, tax_breakdown: [{ type: 'hst', rate: hst.tax_rate, amount: Math.round(taxAmount * 100) / 100 }] };
  }
  for (const rate of rates) {
    const taxAmount = (subtotal * rate.tax_rate) / 100;
    totalTax += taxAmount; totalRate += rate.tax_rate;
    breakdown.push({ type: rate.tax_type, rate: rate.tax_rate, amount: Math.round(taxAmount * 100) / 100 });
  }
  return { tax_amount: Math.round(totalTax * 100) / 100, tax_rate: Math.round(totalRate * 100) / 100, tax_type: rates.map((r) => r.tax_type).join('+'), tax_jurisdiction: stateProvince, tax_breakdown: breakdown };
}

export async function generateInvoiceNumber() {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;
    const prefix = 'INV';
    await connection.execute(`INSERT INTO invoice_sequences (year, month, last_number) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE last_number = last_number + 1`, [currentYear, currentMonth]);
    const [rows] = await connection.execute(`SELECT last_number FROM invoice_sequences WHERE year = ? AND month = ?`, [currentYear, currentMonth]);
    const nextNumber = rows[0].last_number;
    const invoiceNumber = `${prefix}-${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(nextNumber).padStart(5, '0')}`;
    await connection.commit();
    return invoiceNumber;
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

function formatDate(date) {
  if (!date) return 'N/A';
  return new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export async function generateInvoicePDF(invoiceData) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const pdfDir = path.join(process.cwd(), 'uploads', 'invoices');
      if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
      const filename = `invoice-${invoiceData.invoice_number}.pdf`;
      const filepath = path.join(pdfDir, filename);
      const writeStream = fs.createWriteStream(filepath);
      doc.pipe(writeStream);
      const primaryColor = '#2563eb', textColor = '#1f2937', lightGray = '#f3f4f6';
      doc.fontSize(24).fillColor(primaryColor).text('Nordica E-Commerce', 50, 50);
      doc.fontSize(10).fillColor(textColor).text('Nordica Parts & Accessories', 50, 80).text('Email: info@nordica.com', 50, 95);
      doc.fontSize(28).fillColor(primaryColor).text('INVOICE', 350, 50, { align: 'right' });
      doc.fontSize(10).fillColor(textColor).text(`Invoice #: ${invoiceData.invoice_number}`, 350, 85, { align: 'right' }).text(`Invoice Date: ${formatDate(invoiceData.invoice_date || new Date())}`, 350, 100, { align: 'right' }).text(`Order #: ${invoiceData.order_number}`, 350, 115, { align: 'right' });
      let currentY = 180;
      doc.fontSize(11).fillColor(primaryColor).text('BILL TO / SHIP TO:', 50, currentY);
      doc.fontSize(10).fillColor(textColor).text(invoiceData.customer_name || '', 50, currentY + 20).text(invoiceData.customer_email || '', 50, currentY + 35);
      if (invoiceData.shipping_address) {
        const addr = typeof invoiceData.shipping_address === 'string' ? JSON.parse(invoiceData.shipping_address) : invoiceData.shipping_address;
        doc.text(addr.address1 || addr.address || '', 50, currentY + 50).text(`${addr.city || ''}, ${addr.state || addr.province || ''} ${addr.zip || addr.postal_code || ''}`, 50, currentY + 65).text(addr.country || '', 50, currentY + 80);
      }
      currentY += 120;
      doc.rect(50, currentY, 495, 25).fill(lightGray);
      doc.fontSize(10).fillColor(textColor).text('Item', 60, currentY + 8).text('Qty', 320, currentY + 8, { width: 40, align: 'center' }).text('Price', 370, currentY + 8, { width: 60, align: 'right' }).text('Tax', 440, currentY + 8, { width: 45, align: 'right' }).text('Total', 495, currentY + 8, { width: 45, align: 'right' });
      currentY += 30;
      (invoiceData.items || []).forEach((item, index) => {
        if (currentY > 700) { doc.addPage(); currentY = 50; }
        const rowHeight = 30;
        if (index % 2 === 0) doc.rect(50, currentY - 5, 495, rowHeight).fill('#fafafa');
        doc.fontSize(9).fillColor(textColor).text(item.product_name || item.name || 'Product', 60, currentY, { width: 250 }).text(String(item.quantity || 1), 320, currentY, { width: 40, align: 'center' }).text(`$${parseFloat(item.unit_price || 0).toFixed(2)}`, 370, currentY, { width: 60, align: 'right' }).text(`$${parseFloat(item.tax_per_item || 0).toFixed(2)}`, 440, currentY, { width: 45, align: 'right' }).text(`$${parseFloat(item.total || item.total_price || 0).toFixed(2)}`, 495, currentY, { width: 45, align: 'right' });
        currentY += rowHeight;
      });
      currentY += 20;
      const totalsX = 350, labelX = totalsX, amountX = totalsX + 145;
      doc.fontSize(10).fillColor(textColor).text('Subtotal:', labelX, currentY).text(`$${parseFloat(invoiceData.subtotal || 0).toFixed(2)}`, amountX, currentY, { width: 45, align: 'right' });
      currentY += 20;
      if (invoiceData.tax_amount > 0) { doc.text(`Tax (${invoiceData.tax_type || 'Sales Tax'}):`, labelX, currentY).text(`$${parseFloat(invoiceData.tax_amount).toFixed(2)}`, amountX, currentY, { width: 45, align: 'right' }); currentY += 20; }
      if (invoiceData.shipping_amount > 0) { doc.text('Shipping:', labelX, currentY).text(`$${parseFloat(invoiceData.shipping_amount).toFixed(2)}`, amountX, currentY, { width: 45, align: 'right' }); currentY += 20; }
      doc.fontSize(12).fillColor(primaryColor).text('TOTAL:', labelX, currentY).text(`$${parseFloat(invoiceData.total_amount || 0).toFixed(2)}`, amountX, currentY, { width: 45, align: 'right' });
      doc.end();
      writeStream.on('finish', () => resolve({ filepath, filename, url: `/uploads/invoices/${filename}` }));
      writeStream.on('error', reject);
    } catch (error) { reject(error); }
  });
}

export async function createInvoiceFromOrder(orderId) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [orders] = await connection.execute(`SELECT o.*, c.email as customer_email, c.first_name, c.last_name FROM orders o LEFT JOIN customers c ON o.customer_id = c.id WHERE o.id = ?`, [orderId]);
    if (orders.length === 0) throw new Error('Order not found');
    const order = orders[0];
    const [items] = await connection.execute(`SELECT * FROM order_items WHERE order_id = ?`, [orderId]);
    const subtotal = parseFloat(order.subtotal || 0), shipping = parseFloat(order.shipping_cost || 0);
    const shippingAddr = typeof order.shipping_address === 'string' ? JSON.parse(order.shipping_address) : order.shipping_address;
    const country = order.country || shippingAddr?.country || 'US', state = shippingAddr?.state || shippingAddr?.province || '';
    const taxInfo = await calculateTax(subtotal, country, state);
    const invoiceId = uuidv4(), invoiceNumber = await generateInvoiceNumber();
    await connection.execute(`INSERT INTO invoices (id, order_id, user_id, invoice_number, status, subtotal, tax_amount, shipping_amount, total_amount, tax_rate, tax_type, currency, billing_name, billing_email, shipping_address, payment_method, payment_status, payment_reference, invoice_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`, [invoiceId, orderId, order.customer_id, invoiceNumber, 'issued', subtotal, taxInfo.tax_amount, shipping, subtotal + taxInfo.tax_amount + shipping, taxInfo.tax_rate, taxInfo.tax_type, order.currency || 'USD', `${order.first_name} ${order.last_name}`, order.customer_email, JSON.stringify(shippingAddr), order.payment_method, order.payment_status, order.payment_reference]);
    for (let i = 0; i < items.length; i++) {
        const item = items[i], itemSubtotal = parseFloat(item.unit_price) * item.quantity, itemTax = (itemSubtotal * taxInfo.tax_rate) / 100;
        await connection.execute(`INSERT INTO invoice_items (id, invoice_id, product_id, product_name, product_sku, unit_price, quantity, subtotal, tax_per_item, total, line_item_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [uuidv4(), invoiceId, item.product_id, item.product_name, item.sku, item.unit_price, item.quantity, itemSubtotal, itemTax, itemSubtotal + itemTax, i + 1]);
    }
    const fullInvoiceData = { ...order, invoice_number: invoiceNumber, invoice_date: new Date(), items: items, tax_amount: taxInfo.tax_amount, tax_type: taxInfo.tax_type, shipping_amount: shipping, total_amount: subtotal + taxInfo.tax_amount + shipping, customer_name: `${order.first_name} ${order.last_name}`, customer_email: order.customer_email };
    const pdfInfo = await generateInvoicePDF(fullInvoiceData);
    await connection.execute(`UPDATE invoices SET pdf_url = ?, pdf_generated_at = NOW() WHERE id = ?`, [pdfInfo.url, invoiceId]);
    await connection.commit();
    logger.info(`Invoice ${invoiceNumber} created for order ${order.order_number}`);
    return { invoiceId, invoiceNumber, pdfUrl: pdfInfo.url };
  } catch (err) { if (connection) await connection.rollback(); logger.error(`Failed to create invoice from order ${orderId}: ${err.message}`); throw err; } finally { if (connection) connection.release(); }
}

export default { createInvoiceFromOrder, generateInvoicePDF, calculateTax };
