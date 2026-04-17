import PDFDocument from 'pdfkit';
import { PassThrough } from "stream";

/**
 * utils/pdfGenerator.js
 * 
 * Generates professional, high-fidelity PDF invoices for Nordica Ecom / Detail Guardz.
 */

const LOGO_TEXT = "DETAIL GUARDZ";
const PRIMARY_COLOR = "#2563eb"; // Modern Blue
const TEXT_COLOR = "#1f2937";
const LIGHT_GRAY = "#f3f4f6";
const BORDER_COLOR = "#e5e7eb";

/**
 * Helper to get PDF as Buffer
 */
async function getPdfBuffer(generateFn, data) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const stream = new PassThrough();
  const chunks = [];
  
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);

    doc.pipe(stream);
    generateFn(doc, data);
    doc.end();
  });
}

/**
 * Formats date to a readable string
 */
function formatDate(date) {
  if (!date) return new Date().toLocaleDateString();
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Core Invoice Drawing Logic
 */
function drawInvoice(doc, data) {
  // --- HEADER ---
  doc.fontSize(24).fillColor(PRIMARY_COLOR).font('Helvetica-Bold').text(LOGO_TEXT, 50, 50);

  doc
    .fontSize(10)
    .font('Helvetica')
    .fillColor(TEXT_COLOR)
    .text("1905 Sismet Rd", 50, 80)
    .text("Mississauga, ON L4W 4H4", 50, 95)
    .text("Canada", 50, 110)
    .text("Email: info@nordicaplastics.ca", 50, 125);

  doc
    .fontSize(28)
    .fillColor(PRIMARY_COLOR)
    .font('Helvetica-Bold')
    .text('INVOICE', 350, 50, { align: 'right' });

  doc
    .fontSize(10)
    .font('Helvetica')
    .fillColor(TEXT_COLOR)
    .text(`Invoice #: ${data.invoice_number || 'PENDING'}`, 350, 85, { align: 'right' })
    .text(`Order #: ${data.order_number || data.id}`, 350, 100, { align: 'right' })
    .text(`Date: ${formatDate(data.created_at || new Date())}`, 350, 115, { align: 'right' });

  if (data.workflow) {
    doc.fontSize(9).fillColor('#6b7280').text(`Fulfillment: ${data.workflow}`, 350, 130, { align: 'right' });
  }

  // Status Badge
  const statusY = 135;
  const statusText = String(data.payment_status || 'PAID').toUpperCase();
  const statusColor = data.payment_status === 'paid' ? '#10b981' : '#f59e0b';

  doc.rect(480, statusY, 65, 18).fill(statusColor);
  doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold').text(statusText, 480, statusY + 5, { width: 65, align: 'center' });

  // --- BILLING / SHIPPING ---
  let currentY = 180;
  doc.fontSize(11).fillColor(PRIMARY_COLOR).font('Helvetica-Bold').text('BILL TO:', 50, currentY);
  doc.fontSize(11).text('SHIP TO:', 320, currentY);

  doc.fontSize(10).font('Helvetica').fillColor(TEXT_COLOR);
  
  // Bill To (Customer Info)
  const name = data.shipping_first_name ? `${data.shipping_first_name} ${data.shipping_last_name}` : (data.customer_name || 'Valued Customer');
  doc.text(name, 50, currentY + 20)
     .text(data.customer_email || '', 50, currentY + 35);

  // Ship To (Address)
  const s = data.shipping_address && typeof data.shipping_address === 'string' ? JSON.parse(data.shipping_address) : (data.shipping_address || {});
  doc.text(name, 320, currentY + 20)
     .text(s.address1 || s.address || '', 320, currentY + 35)
     .text(`${s.city || ''}, ${s.state || s.province || ''} ${s.zip || s.postalCode || ''}`, 320, currentY + 50)
     .text(s.country || (data.country === 'CA' ? 'Canada' : 'USA'), 320, currentY + 65);

  currentY += 100;

  // --- ITEMS TABLE ---
  doc.rect(50, currentY, 495, 25).fill(LIGHT_GRAY);
  doc.fontSize(10).fillColor(TEXT_COLOR).font('Helvetica-Bold');
  doc.text('Item', 60, currentY + 8)
     .text('Qty', 320, currentY + 8, { width: 40, align: 'center' })
     .text('Price', 370, currentY + 8, { width: 60, align: 'right' })
     .text('Total', 480, currentY + 8, { width: 60, align: 'right' });

  currentY += 30;
  doc.font('Helvetica').fontSize(9);

  const items = data.items || [];
  items.forEach((item, index) => {
    if (currentY > 700) {
      doc.addPage();
      currentY = 50;
    }

    if (index % 2 === 0) {
      doc.rect(50, currentY - 5, 495, 25).fill('#fafafa');
    }

    const price = parseFloat(item.unit_price || item.price_at_purchase || 0);
    const qty = parseInt(item.quantity || 1);
    const total = parseFloat((price * qty).toFixed(2));

    doc.fillColor(TEXT_COLOR)
       .text(item.product_name_at_purchase || item.product_name || 'Product', 60, currentY, { width: 250 })
       .text(qty.toString(), 320, currentY, { width: 40, align: 'center' })
       .text(`$${price.toFixed(2)}`, 370, currentY, { width: 60, align: 'right' })
       .text(`$${total.toFixed(2)}`, 480, currentY, { width: 60, align: 'right' });

    currentY += 25;
    doc.moveTo(50, currentY).lineTo(545, currentY).strokeColor(BORDER_COLOR).lineWidth(0.5).stroke();
    currentY += 5;
  });

  // --- TOTALS ---
  currentY += 20;
  const totalsX = 350;
  const amountX = 480;

  doc.fontSize(10).font('Helvetica');
  doc.text('Subtotal:', totalsX, currentY)
     .text(`$${parseFloat(data.subtotal || 0).toFixed(2)}`, amountX, currentY, { width: 60, align: 'right' });
  
  currentY += 20;
  doc.text(`Tax (${data.tax_type || 'Tax'}):`, totalsX, currentY)
     .text(`$${parseFloat(data.tax || data.tax_amount || 0).toFixed(2)}`, amountX, currentY, { width: 60, align: 'right' });

  currentY += 20;
  doc.text('Shipping:', totalsX, currentY)
     .text(`$${parseFloat(data.shipping_cost || data.shipping_amount || 0).toFixed(2)}`, amountX, currentY, { width: 60, align: 'right' });

  currentY += 30;
  doc.rect(totalsX - 10, currentY - 5, 205, 30).fill(PRIMARY_COLOR);
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#ffffff');
  doc.text('TOTAL:', totalsX, currentY + 5)
     .text(`$${parseFloat(data.total || data.total_amount || 0).toFixed(2)}`, amountX, currentY + 5, { width: 60, align: 'right' });

  // --- FOOTER ---
  const footerY = 750;
  doc.moveTo(50, footerY).lineTo(545, footerY).strokeColor(BORDER_COLOR).stroke();
  doc.fontSize(8).fillColor('#6b7280').font('Helvetica')
     .text('Thank you for choosing Detail Guardz!', 50, footerY + 10)
     .text('For support, please contact info@nordicaplastics.ca', 50, footerY + 22);
}

/**
 * Public API
 */
export const generateInvoiceBuffer = (data) => getPdfBuffer(drawInvoice, data);

export default { generateInvoiceBuffer };
