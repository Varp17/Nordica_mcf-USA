import PDFDocument from 'pdfkit';
import { PassThrough } from "stream";


/**
 * utils/pdfGenerator.js
 * 
 * Generates professional PDF invoices and packing slips for Nordica Ecom.
 */

const LOGO_TEXT = "NORDICA PLASTICS";

/**
 * Helper to get PDF as Buffer
 */
async function getPdfBuffer(generateFn, order) {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  
  const promise = new Promise((resolve) => {
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });

  await generateFn(order, stream);
  return await promise;
}

export const generateInvoiceBuffer = (order) => getPdfBuffer(generateInvoicePDF, order);
export const generatePackingSlipBuffer = (order) => getPdfBuffer(generatePackingSlipPDF, order);

/**
 * Generate Invoice PDF
 * @param {object} order - Full order object with items
 */
export async function generateInvoicePDF(order, stream) {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });

  // Pipe to the output stream (could be a file or express response)
  doc.pipe(stream);

  // --- HEADER ---
  doc.fillColor("#444444").fontSize(20).text(LOGO_TEXT, 50, 45);
  doc.fontSize(10).text("1905 Sismet Rd", 200, 50, { align: "right" });
  doc.text("Mississauga, ON L4W 4H4", 200, 65, { align: "right" });
  doc.text("Canada", 200, 80, { align: "right" });
  doc.moveDown();

  // --- INVOICE TITLE ---
  doc.fillColor("#1a1a2e").fontSize(20).text("INVOICE", 50, 160);
  
  generateHr(doc, 185);

  const customerInfoTop = 200;

  doc.fontSize(10)
     .text("Order Number:", 50, customerInfoTop)
     .font("Helvetica-Bold").text(order.id, 150, customerInfoTop)
     .font("Helvetica").text("Invoice Date:", 50, customerInfoTop + 15)
     .text(new Date(order.created_at || order.order_date).toLocaleDateString(), 150, customerInfoTop + 15)
     .text("Payment Status:", 50, customerInfoTop + 30)
     .text((order.payment_status || 'Paid').toUpperCase(), 150, customerInfoTop + 30);

  const shipping = typeof order.shipping_address === 'string' ? JSON.parse(order.shipping_address) : order.shipping_address;
  
  doc.font("Helvetica-Bold").text("Ship To:", 300, customerInfoTop);
  doc.font("Helvetica")
     .text(shipping?.name || `${order.first_name} ${order.last_name}`, 300, customerInfoTop + 15)
     .text(shipping?.address1 || shipping?.line1, 300, customerInfoTop + 30)
     if (shipping?.address2) doc.text(shipping.address2, 300, customerInfoTop + 45);
  doc.text(`${shipping?.city}, ${shipping?.state || shipping?.province} ${shipping?.postal_code || shipping?.zip}`, 300, customerInfoTop + (shipping?.address2 ? 60 : 45))
     .text(shipping?.country || "Canada", 300, customerInfoTop + (shipping?.address2 ? 75 : 60));

  generateHr(doc, 300);

  // --- ITEMS TABLE ---
  let i;
  const invoiceTableTop = 330;

  doc.font("Helvetica-Bold");
  generateTableRow(doc, invoiceTableTop, "Item", "Quantity", "Unit Cost", "Total");
  generateHr(doc, invoiceTableTop + 20);
  doc.font("Helvetica");

  let position = 0;
  const items = order.items || [];
  for (i = 0; i < items.length; i++) {
    const item = items[i];
    position = invoiceTableTop + 30 + (i * 30);
    generateTableRow(
      doc,
      position,
      item.product_name_at_purchase || item.name || "Product",
      item.quantity.toString(),
      `$${parseFloat(item.price_at_purchase || item.price).toFixed(2)}`,
      `$${(parseFloat(item.price_at_purchase || item.price) * item.quantity).toFixed(2)}`
    );
    generateHr(doc, position + 20);
  }

  const subtotalPosition = position + 40;
  generateTableRow(doc, subtotalPosition, "", "", "Subtotal", `$${parseFloat(order.subtotal || 0).toFixed(2)}`);

  const shippingPosition = subtotalPosition + 20;
  generateTableRow(doc, shippingPosition, "", "", "Shipping", `$${parseFloat(order.shipping_cost || 0).toFixed(2)}`);

  const taxPosition = shippingPosition + 20;
  generateTableRow(doc, taxPosition, "", "", "Tax", `$${parseFloat(order.tax_amount || 0).toFixed(2)}`);

  const duePosition = taxPosition + 25;
  doc.font("Helvetica-Bold");
  generateTableRow(doc, duePosition, "", "", "Grand Total", `$${parseFloat(order.total || order.total_amount).toFixed(2)}`);
  doc.font("Helvetica");

  // --- FOOTER ---
  doc.fontSize(10).text("Thank you for your business. For support, email info@nordicaplastics.ca", 50, 750, { align: "center", width: 500 });

  doc.end();
}

/**
 * Generate Packing Slip PDF
 */
export async function generatePackingSlipPDF(order, stream) {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    doc.pipe(stream);

    doc.fillColor("#444444").fontSize(20).text(LOGO_TEXT, 50, 45);
    doc.fontSize(20).text("PACKING SLIP", 200, 50, { align: "right" });
    
    generateHr(doc, 85);

    const infoTop = 110;
    doc.fontSize(10)
       .font("Helvetica-Bold").text("Order #:", 50, infoTop)
       .font("Helvetica").text(order.id, 100, infoTop)
       .font("Helvetica-Bold").text("Date:", 50, infoTop + 15)
       .font("Helvetica").text(new Date(order.created_at || order.order_date).toLocaleDateString(), 100, infoTop + 15);

    const shipping = typeof order.shipping_address === 'string' ? JSON.parse(order.shipping_address) : order.shipping_address;

    doc.rect(50, 160, 500, 100).fill("#f9f9f9").stroke("#eeeeee");
    doc.fillColor("#1a1a2e").font("Helvetica-Bold").text("SHIP TO:", 70, 180);
    doc.fillColor("#444444").font("Helvetica")
       .text(shipping?.name || `${order.first_name} ${order.last_name}`, 70, 195)
       .text(shipping?.address1 || shipping?.line1, 70, 210);
    if (shipping?.address2) doc.text(shipping.address2, 70, 225);
    doc.text(`${shipping?.city}, ${shipping?.state || shipping?.province} ${shipping?.postal_code || shipping?.zip}`, 70, shipping?.address2 ? 240 : 225);

    const tableTop = 300;
    doc.font("Helvetica-Bold").fontSize(12).text("Items to Pack", 50, tableTop);
    generateHr(doc, tableTop + 20);

    doc.fontSize(10);
    let position = tableTop + 30;
    const items = order.items || [];
    
    items.forEach((item, index) => {
        position = tableTop + 40 + (index * 35);
        
        doc.font("Helvetica-Bold").text(`${item.quantity} x`, 50, position);
        doc.font("Helvetica").text(item.product_name_at_purchase || item.name || "Product", 100, position);
        generateHr(doc, position + 20);
    });

    doc.end();
}

function generateHr(doc, y) {
  doc.strokeColor("#aaaaaa").lineWidth(1).moveTo(50, y).lineTo(550, y).stroke();
}

function generateTableRow(doc, y, item, qty, unit, total) {
  doc.fontSize(10)
    .text(item, 50, y, { width: 250 })
    .text(qty, 300, y, { width: 50, align: "right" })
    .text(unit, 360, y, { width: 90, align: "right" })
    .text(total, 470, y, { width: 80, align: "right" });
}
