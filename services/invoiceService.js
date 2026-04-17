import db from '../config/database.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';
import { generateInvoiceBuffer } from '../utils/pdfGenerator.js';
import { uploadBuffer } from './s3Service.js';
import { sendOrderConfirmationEmail } from '../utils/mailer.js';
import Order from '../models/Order.js';

/**
 * invoiceService.js
 * 
 * Orchestrates the post-payment invoice workflow.
 * Now separated into MCF (US) and Shippo (Canada) workflows as requested.
 */

/**
 * createMCFInvoice (US Workflow)
 * ------------------------------
 * Handles formal invoice generation for US orders fulfilled by Amazon MCF.
 */
export async function createMCFInvoice(orderId) {
    try {
        logger.info(`📄 [MCF WORKFLOW] Starting invoice processing for order ${orderId}`);

        const order = await Order.findById(orderId);
        if (!order) throw new Error(`Order ${orderId} not found`);

        // Generate sequential invoice number
        const [invNumRows] = await db.execute('CALL generate_invoice_number(@invNum)');
        const [[{ invoiceNumber: invNum }]] = await db.execute('SELECT @invNum AS invoiceNumber');
        const finalInvNum = invNum || `INV-US-${new Date().getFullYear()}-${order.order_number}`;

        const invoiceId = uuidv4();
        await db.execute(
            `INSERT INTO invoices (
                id, order_id, user_id, invoice_number, status,
                subtotal, tax_amount, shipping_amount, total_amount,
                currency, billing_name, billing_email, shipping_address,
                payment_method, payment_status, payment_reference, invoice_date, fulfillment_channel
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'amazon_mcf')`,
            [
                invoiceId, orderId, order.user_id, finalInvNum, 'issued',
                order.subtotal, order.tax, order.shipping_cost, order.total,
                order.currency, `${order.shipping_first_name} ${order.shipping_last_name}`,
                order.customer_email, order.shipping_address,
                order.payment_method, order.payment_status, order.payment_reference
            ]
        );

        // Create Invoice Items
        for (let i = 0; i < order.items.length; i++) {
            const item = order.items[i];
            await db.execute(
                `INSERT INTO invoice_items (
                    id, invoice_id, product_id, product_name, product_sku, unit_price, quantity, subtotal, total, line_item_number
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    uuidv4(), invoiceId, item.product_id, 
                    item.product_name_at_purchase || item.product_name, 
                    item.sku, item.unit_price, item.quantity, 
                    item.total_price, item.total_price, i + 1
                ]
            );
        }

        const pdfBuffer = await generateInvoiceBuffer({ ...order, invoice_number: finalInvNum, workflow: 'MCF' });
        const s3Key = `invoices/us/invoice_${finalInvNum}_${orderId}.pdf`;
        const s3Url = await uploadBuffer(pdfBuffer, s3Key, "application/pdf");

        await db.execute(`UPDATE invoices SET pdf_url = ?, pdf_generated_at = NOW() WHERE id = ?`, [s3Url, invoiceId]);
        await db.execute(`UPDATE orders SET invoice_pdf_url = ? WHERE id = ?`, [s3Url, orderId]);

        await sendOrderConfirmationEmail({
            to: order.customer_email,
            name: `${order.shipping_first_name} ${order.shipping_last_name}` || 'Valued Customer',
            order: order,
            invoicePdf: pdfBuffer
        });

        logger.info(`✅ [MCF] Invoice ${finalInvNum} created: ${s3Url}`);
        return { success: true, invoiceNumber: finalInvNum, s3Url };
    } catch (error) {
        logger.error(`❌ MCF Invoice Error for ${orderId}: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * createShippoInvoice (Canada Workflow)
 * ------------------------------------
 * Handles formal invoice generation for Canadian orders fulfilled via Shippo.
 */
export async function createShippoInvoice(orderId) {
    try {
        logger.info(`📄 [SHIPPO WORKFLOW] Starting invoice processing for order ${orderId}`);

        const order = await Order.findById(orderId);
        if (!order) throw new Error(`Order ${orderId} not found`);

        const [invNumRows] = await db.execute('CALL generate_invoice_number(@invNum)');
        const [[{ invoiceNumber: invNum }]] = await db.execute('SELECT @invNum AS invoiceNumber');
        const finalInvNum = invNum || `INV-CA-${new Date().getFullYear()}-${order.order_number}`;

        const invoiceId = uuidv4();
        await db.execute(
            `INSERT INTO invoices (
                id, order_id, user_id, invoice_number, status,
                subtotal, tax_amount, shipping_amount, total_amount,
                currency, billing_name, billing_email, shipping_address,
                payment_method, payment_status, payment_reference, invoice_date, fulfillment_channel
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'shippo')`,
            [
                invoiceId, orderId, order.user_id, finalInvNum, 'issued',
                order.subtotal, order.tax, order.shipping_cost, order.total,
                order.currency, `${order.shipping_first_name} ${order.shipping_last_name}`,
                order.customer_email, order.shipping_address,
                order.payment_method, order.payment_status, order.payment_reference
            ]
        );

        for (let i = 0; i < order.items.length; i++) {
            const item = order.items[i];
            await db.execute(
                `INSERT INTO invoice_items (
                    id, invoice_id, product_id, product_name, product_sku, unit_price, quantity, subtotal, total, line_item_number
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    uuidv4(), invoiceId, item.product_id, 
                    item.product_name_at_purchase || item.product_name, 
                    item.sku, item.unit_price, item.quantity, 
                    item.total_price, item.total_price, i + 1
                ]
            );
        }

        const pdfBuffer = await generateInvoiceBuffer({ ...order, invoice_number: finalInvNum, workflow: 'SHIPPO' });
        const s3Key = `invoices/ca/invoice_${finalInvNum}_${orderId}.pdf`;
        const s3Url = await uploadBuffer(pdfBuffer, s3Key, "application/pdf");

        await db.execute(`UPDATE invoices SET pdf_url = ?, pdf_generated_at = NOW() WHERE id = ?`, [s3Url, invoiceId]);
        await db.execute(`UPDATE orders SET invoice_pdf_url = ? WHERE id = ?`, [s3Url, orderId]);

        await sendOrderConfirmationEmail({
            to: order.customer_email,
            name: `${order.shipping_first_name} ${order.shipping_last_name}` || 'Valued Customer',
            order: order,
            invoicePdf: pdfBuffer
        });

        logger.info(`✅ [SHIPPO] Invoice ${finalInvNum} created: ${s3Url}`);
        return { success: true, invoiceNumber: finalInvNum, s3Url };
    } catch (error) {
        logger.error(`❌ Shippo Invoice Error for ${orderId}: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// Backward compatibility (optional, but good for on-demand route)
export async function createInvoiceFromOrder(orderId) {
    const order = await Order.findById(orderId);
    if (!order) return { success: false, error: "Order not found" };
    return order.country === 'US' ? createMCFInvoice(orderId) : createShippoInvoice(orderId);
}

export default { createMCFInvoice, createShippoInvoice, createInvoiceFromOrder };
