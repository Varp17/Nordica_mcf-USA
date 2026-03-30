'use strict';

/**
 * Email Notification Service
 * ───────────────────────────
 * Sends transactional emails via SMTP (SendGrid / SES / Mailgun compatible).
 * Templates:
 *   - Order Confirmation  (after payment)
 *   - Order Shipped       (after fulfillment + tracking number)
 *   - Out for Delivery
 *   - Order Delivered
 *   - Fulfillment Error   (internal alert to admin)
 */

// const nodemailer = require('nodemailer');
// const logger     = require('../utils/logger');
// const { formatCurrency } = require('../utils/helpers');
import nodemailer from 'nodemailer';
import logger from '../utils/logger.js';
import { formatCurrency } from '../utils/helpers.js';

// ── Transporter (singleton) ────────────────────────────────────────────────
let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
  const smtpPort = parseInt(process.env.SMTP_PORT || '465');
  
  // Gmail on 465 requires secure: true
  const isSecure = (smtpPort === 465);

  _transporter = nodemailer.createTransport({
    host:   smtpHost,
    port:   smtpPort,
    secure: isSecure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    // Reliability settings
    pool: false, // Disabling pool to avoid IPv6 issues in some environments
    connectionTimeout: 20000, 
    greetingTimeout: 10000,
    socketTimeout: 30000,
    tls: {
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2'
    },
    // CRITICAL: Forces IPv4 to bypass the ENETUNREACH errors in production
    family: 4 
  });

  _transporter.verify((err) => {
    if (err) logger.warn(`SMTP connection warning (IPv4): ${err.message}`);
    else     logger.info(`SMTP transporter ready on ${smtpHost}:${smtpPort} (IPv4)`);
  });

  return _transporter;
}

// ── Base send function ─────────────────────────────────────────────────────
export async function sendEmail({ to, subject, html, text }) {
  const transporter = getTransporter();
  const fromName    = process.env.EMAIL_FROM_NAME    || 'Your Store';
  const fromAddress = process.env.EMAIL_FROM_ADDRESS || 'noreply@yourstore.com';

  try {
    const info = await transporter.sendMail({
      from:    `"${fromName}" <${fromAddress}>`,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]+>/g, ''),
      attachments: arguments[0].attachments || []
    });
    logger.info(`Email sent: ${subject} → ${to} [${info.messageId}]`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    logger.error(`Email send failed: ${err.message}`, { to, subject });
    return { success: false, error: err.message };
  }
}

// ── Shared CSS ─────────────────────────────────────────────────────────────
const baseStyle = `
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
           background: #f4f6f9; margin: 0; padding: 0; color: #333; }
    .wrapper { max-width: 600px; margin: 30px auto; background: #ffffff;
               border-radius: 8px; overflow: hidden;
               box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .header  { background: #1E3A5F; padding: 28px 32px; }
    .header h1 { color: #ffffff; margin: 0; font-size: 22px; font-weight: 600; }
    .header p  { color: #a8c4e0; margin: 4px 0 0; font-size: 13px; }
    .body    { padding: 32px; }
    .body h2 { font-size: 20px; color: #1E3A5F; margin: 0 0 12px; }
    .body p  { font-size: 15px; line-height: 1.6; color: #555; margin: 0 0 14px; }
    .highlight-box { background: #f0f6ff; border-left: 4px solid #2E86AB;
                     border-radius: 4px; padding: 16px 20px; margin: 20px 0; }
    .highlight-box p { margin: 4px 0; font-size: 14px; color: #333; }
    .highlight-box .label { font-weight: 600; color: #1E3A5F; }
    .btn { display: inline-block; background: #2E86AB; color: #ffffff;
           text-decoration: none; padding: 12px 28px; border-radius: 6px;
           font-weight: 600; font-size: 15px; margin: 8px 0; }
    .btn:hover { background: #1a6a8a; }
    .order-table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
    .order-table th { background: #f0f4f8; text-align: left; padding: 10px 12px;
                      color: #1E3A5F; font-weight: 600; border-bottom: 2px solid #ddd; }
    .order-table td { padding: 10px 12px; border-bottom: 1px solid #eee; color: #555; }
    .order-table tr:last-child td { border-bottom: none; }
    .totals-row td { font-weight: 600; color: #333; background: #f9fafb; }
    .status-badge { display: inline-block; padding: 4px 12px; border-radius: 20px;
                    font-size: 12px; font-weight: 600; text-transform: uppercase; }
    .status-shipped   { background: #d4f5e2; color: #166534; }
    .status-delivered { background: #dbeafe; color: #1e40af; }
    .footer { background: #f0f4f8; padding: 20px 32px; text-align: center;
              font-size: 12px; color: #888; }
    .footer a { color: #2E86AB; text-decoration: none; }
  </style>
`;

function wrapEmail(headerTitle, headerSub, bodyContent) {
  const storeName    = process.env.STORE_NAME    || 'Detail Guardz';
  const storeWebsite = process.env.STORE_WEBSITE  || 'https://detailguardz.com';
  const supportEmail = process.env.STORE_SUPPORT_EMAIL || 'info@detailguardz.com';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">${baseStyle}</head><body>
  <div class="wrapper">
    <div class="header">
      <h1>${storeName}</h1>
      <p>${headerSub}</p>
    </div>
    <div class="body">
      <h2>${headerTitle}</h2>
      ${bodyContent}
    </div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} ${storeName}. All rights reserved.</p>
      <p><a href="${storeWebsite}">${storeWebsite}</a> &nbsp;|&nbsp;
         <a href="mailto:${supportEmail}">Contact Support</a></p>
      <p style="margin-top:8px; font-size:11px; color:#aaa;">
        This email was sent because you placed an order with us.
      </p>
    </div>
  </div></body></html>`;
}

function itemsTableHtml(items = [], subtotal, shipping, tax, total) {
  const rows = (items || []).map(item => `
    <tr>
      <td>${item.product_name}</td>
      <td style="text-align:center;">${item.quantity}</td>
      <td style="text-align:right;">${formatCurrency(item.unit_price)}</td>
      <td style="text-align:right;">${formatCurrency(item.unit_price * item.quantity)}</td>
    </tr>`).join('');

  return `
    <table class="order-table">
      <thead><tr>
        <th>Product</th>
        <th style="text-align:center;">Qty</th>
        <th style="text-align:right;">Unit Price</th>
        <th style="text-align:right;">Total</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="totals-row"><td colspan="3">Subtotal</td><td style="text-align:right;">${formatCurrency(subtotal)}</td></tr>
        <tr class="totals-row"><td colspan="3">Shipping</td><td style="text-align:right;">${formatCurrency(shipping || 0)}</td></tr>
        <tr class="totals-row"><td colspan="3">Tax</td><td style="text-align:right;">${formatCurrency(tax || 0)}</td></tr>
        <tr class="totals-row" style="font-size:16px;"><td colspan="3"><strong>Order Total</strong></td>
          <td style="text-align:right;"><strong>${formatCurrency(total)}</strong></td></tr>
      </tfoot>
    </table>`;
}

export async function sendOrderConfirmationEmail(order, invoicePdf = null) {
  const firstName = order.shipping_first_name || 'Customer';
  const table     = itemsTableHtml(order.items, order.subtotal, order.shipping_cost, order.tax, order.total);

  const body = `
    <p>Hi ${firstName},</p>
    <p>Thank you for your order! We've received your payment and your order is now being processed.</p>
    <div class="highlight-box">
      <p><span class="label">Order Number:</span> ${order.order_number}</p>
      <p><span class="label">Order Date:</span> ${new Date(order.created_at).toLocaleDateString('en-US', { dateStyle: 'long' })}</p>
      <p><span class="label">Ship To:</span> ${order.shipping_first_name} ${order.shipping_last_name},
         ${order.shipping_address1}, ${order.shipping_city}, ${order.shipping_state || order.shipping_province} ${order.shipping_zip || order.shipping_postal_code}</p>
    </div>
    <p><strong>Order Summary:</strong></p>
    ${table}
    <p>We'll send you another email as soon as your order ships with your tracking information.</p>
    <p>If you have any questions, reply to this email or contact <a href="mailto:${process.env.STORE_SUPPORT_EMAIL}">${process.env.STORE_SUPPORT_EMAIL}</a>.</p>
  `;

  const mailOptions = {
    to:      order.customer_email,
    subject: `Order Confirmed — #${order.order_number}`,
    html:    wrapEmail('Order Confirmed! 🎉', `Order #${order.order_number}`, body)
  };

  if (invoicePdf) {
    mailOptions.attachments = [{
      filename: `invoice-${order.order_number}.pdf`,
      path: invoicePdf
    }];
  }

  return sendEmail(mailOptions);
}

export async function sendOrderShippedEmail(order, tracking) {
  const firstName = order.shipping_first_name || 'Customer';
  const estDelivery = tracking.estimatedDelivery
    ? new Date(tracking.estimatedDelivery).toLocaleDateString('en-US', { dateStyle: 'long' })
    : 'Check tracking link';

  const body = `
    <p>Hi ${firstName},</p>
    <p>Great news! Your order <strong>#${order.order_number}</strong> has been shipped and is on its way to you.</p>
    <div class="highlight-box">
      <p><span class="label">Carrier:</span> ${tracking.carrier || 'Carrier'}</p>
      <p><span class="label">Tracking Number:</span> <strong>${tracking.trackingNumber}</strong></p>
      <p><span class="label">Estimated Delivery:</span> ${estDelivery}</p>
    </div>
    ${tracking.trackingUrl ? `
    <p style="text-align:center; margin:24px 0;">
      <a href="${tracking.trackingUrl}" class="btn">📦 Track My Package</a>
    </p>` : ''}
    <p>Your package is being shipped to:<br>
       ${order.shipping_first_name} ${order.shipping_last_name}<br>
       ${order.shipping_address1}${order.shipping_address2 ? ', ' + order.shipping_address2 : ''}<br>
       ${order.shipping_city}, ${order.shipping_state || order.shipping_province}
       ${order.shipping_zip || order.shipping_postal_code}</p>
    <p>If you have any questions about your shipment, please contact us at
       <a href="mailto:${process.env.STORE_SUPPORT_EMAIL}">${process.env.STORE_SUPPORT_EMAIL}</a>.</p>
  `;

  return sendEmail({
    to:      order.customer_email,
    subject: `Your Order Has Shipped! Tracking: ${tracking.trackingNumber}`,
    html:    wrapEmail('Your Order Is On Its Way! 🚚', `Order #${order.order_number}`, body)
  });
}

export async function sendOrderDeliveredEmail(order) {
  const firstName  = order.shipping_first_name || 'Customer';
  const storeName  = process.env.STORE_NAME    || 'Our Store';
  const storeUrl   = process.env.STORE_WEBSITE  || 'https://yourstore.com';

  const body = `
    <p>Hi ${firstName},</p>
    <p>Your order <strong>#${order.order_number}</strong> has been delivered! 🎉</p>
    <div class="highlight-box">
      <p><span class="label">Order:</span> #${order.order_number}</p>
      <p><span class="label">Delivered To:</span> ${order.shipping_address1}, ${order.shipping_city}</p>
      <p><span class="label">Tracking:</span> ${order.tracking_number}</p>
    </div>
    <p>We hope you love your purchase! If you have any issues with your order,
       please don't hesitate to reach out to us.</p>
    <p style="text-align:center; margin:24px 0;">
      <a href="${storeUrl}" class="btn">Shop Again</a>
    </p>
    <p>Thank you for shopping with ${storeName}!</p>
  `;

  return sendEmail({
    to:      order.customer_email,
    subject: `Your Order Has Been Delivered! #${order.order_number}`,
    html:    wrapEmail('Package Delivered! ✅', `Order #${order.order_number}`, body)
  });
}

export async function sendFulfillmentErrorAlert(order, error) {
  const adminEmail = process.env.ADMIN_ALERT_EMAIL || process.env.STORE_SUPPORT_EMAIL || process.env.EMAIL_FROM_ADDRESS;

  const body = `
    <p><strong>⚠️ Fulfillment Error — Immediate Attention Required</strong></p>
    <div class="highlight-box">
      <p><span class="label">Order ID:</span> ${order.id}</p>
      <p><span class="label">Order Number:</span> ${order.order_number}</p>
      <p><span class="label">Country:</span> ${order.country}</p>
      <p><span class="label">Customer:</span> ${order.customer_email}</p>
      <p><span class="label">Error:</span> ${error.message || String(error)}</p>
      <p><span class="label">Timestamp:</span> ${new Date().toISOString()}</p>
    </div>
    <pre style="background:#f5f5f5;padding:12px;border-radius:4px;font-size:12px;overflow:auto;">
${error.stack || String(error)}</pre>
    <p>Please investigate and manually process this order if needed.</p>
  `;

  return sendEmail({
    to:      adminEmail,
    subject: `[URGENT] Fulfillment Failed — Order #${order.order_number}`,
    html:    wrapEmail('Fulfillment Error Alert', 'Action Required', body)
  });
}

export async function sendOTPEmail(email, otp) {
  const storeName = process.env.STORE_NAME || 'Detail Guardz';
  const body = `
    <p>Welcome to ${storeName}!</p>
    <p>To complete your registration, please use the following verification code:</p>
    <div style="text-align: center; margin: 30px 0;">
      <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #1E3A5F; background: #f0f6ff; padding: 10px 20px; border-radius: 4px; border: 1px dashed #2E86AB;">
        ${otp}
      </span>
    </div>
    <p>This code will expire in 10 minutes. If you did not request this code, please ignore this email.</p>
    <p>Best regards,<br>The ${storeName} Team</p>
  `;

  return sendEmail({
    to: email,
    subject: `Verify Your Email — ${otp}`,
    html: wrapEmail('Email Verification', 'Verification Code', body)
  });
}

export async function sendWelcomeEmail(email, firstName) {
  const storeName = process.env.STORE_NAME || 'Detail Guardz';
  const storeUrl = process.env.STORE_WEBSITE || 'https://detailguardz.com';

  const body = `
    <p>Hi ${firstName},</p>
    <p>Welcome to <strong>${storeName}</strong>! We're thrilled to have you join our community of detailing enthusiasts.</p>
    <div class="highlight-box">
      <p>Your account is now fully verified and ready to use. You can start exploring our premium car care products right away!</p>
    </div>
    <p>As a member, you'll be the first to know about new product launches, exclusive detailing tips, and seasonal promotions.</p>
    <p style="text-align:center; margin:32px 0;">
      <a href="${storeUrl}" class="btn">✨ Start Shopping Now</a>
    </p>
    <p>If you have any questions or need advice on which products are right for your vehicle, our support team is always here to help.</p>
    <p>Happy detailing!<br>The ${storeName} Team</p>
  `;

  return sendEmail({
    to: email,
    subject: `Welcome to ${storeName}! ✨`,
    html: wrapEmail(`Welcome aboard, ${firstName}!`, 'Account Verified', body)
  });
}

export async function sendStockAlertEmail(productName, currentStock, sku) {
  const adminEmail = process.env.ADMIN_ALERT_EMAIL || 'k7391356@gmail.com';
  const isOutOfStock = currentStock <= 0;
  const statusLabel = isOutOfStock ? 'OUT OF STOCK' : 'LOW STOCK';
  const color = isOutOfStock ? '#dc2626' : '#ea580c';

  const body = `
    <p><strong>⚠️ Inventory Alert: ${statusLabel}</strong></p>
    <div class="highlight-box" style="border-left-color: ${color};">
      <p><span class="label">Product:</span> ${productName}</p>
      <p><span class="label">SKU:</span> ${sku || 'N/A'}</p>
      <p><span class="label">Current Level:</span> <strong style="color: ${color};">${currentStock}</strong></p>
      <p><span class="label">Status:</span> ${statusLabel}</p>
    </div>
    <p>Please restock this item as soon as possible to avoid lost sales.</p>
  `;

  return sendEmail({
    to: adminEmail,
    subject: `[INVENTORY] ${statusLabel}: ${productName}`,
    html: wrapEmail('Inventory Alert', 'Stock Management', body)
  });
}

export async function sendTrackingUpdateEmail(order, tracking) {
  const firstName = order.shipping_first_name || order.first_name || 'Customer';
  const email     = order.customer_email || order.email;
  const orderNum  = order.order_number || order.id;

  const statusLabels = {
    PRE_TRANSIT: 'Label Created — Awaiting Carrier Pickup',
    TRANSIT:     'In Transit — On Its Way!',
    DELIVERED:   'Delivered! 🎉',
    RETURNED:    'Returned to Sender',
    FAILURE:     'Delivery Issue — Contact Support',
    UNKNOWN:     'Status Update'
  };

  const statusLabel = statusLabels[(tracking.status || '').toUpperCase()] || tracking.status || 'Status Update';

  const locationStr = tracking.location
    ? (typeof tracking.location === 'object'
        ? [tracking.location.city, tracking.location.state, tracking.location.country].filter(Boolean).join(', ')
        : String(tracking.location))
    : null;

  const body = `
    <p>Hi ${firstName},</p>
    <p>There's an update on your order <strong>#${orderNum}</strong>.</p>
    <div class="highlight-box">
      <p><span class="label">Status:</span> <span class="status-badge status-shipped">${statusLabel}</span></p>
      <p><span class="label">Tracking Number:</span> <strong>${tracking.trackingNumber || 'N/A'}</strong></p>
      ${tracking.statusDate ? `<p><span class="label">Updated:</span> ${new Date(tracking.statusDate).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</p>` : ''}
      ${locationStr ? `<p><span class="label">Location:</span> ${locationStr}</p>` : ''}
    </div>
    <p>If you have any questions, please contact
       <a href="mailto:${process.env.STORE_SUPPORT_EMAIL}">${process.env.STORE_SUPPORT_EMAIL}</a>.</p>
  `;

  return sendEmail({
    to:      email,
    subject: `Tracking Update — Order #${orderNum}: ${statusLabel}`,
    html:    wrapEmail(`Tracking Update: ${statusLabel}`, `Order #${orderNum}`, body)
  });
}

export async function sendPasswordResetOTPEmail(email, otp) {
  const storeName = process.env.STORE_NAME || 'Detail Guardz';
  const body = `
    <p>We received a request to reset your ${storeName} account password.</p>
    <p>Please use the following code to authorize this change:</p>
    <div style="text-align: center; margin: 30px 0;">
      <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #1E3A5F; background: #fffbe6; padding: 10px 20px; border-radius: 4px; border: 1px dashed #faad14;">
        ${otp}
      </span>
    </div>
    <p>This code will expire in 15 minutes. <strong>If you did not request this, please ignore this email and your password will remain unchanged.</strong></p>
    <p>Best regards,<br>The ${storeName} Team</p>
  `;

  return sendEmail({
    to: email,
    subject: `Password Reset Code — ${otp}`,
    html: wrapEmail('Password Reset Request', 'Action Required', body)
  });
}

export async function sendContactChangeOTPEmail(email, otp, type = 'email') {
  const storeName = process.env.STORE_NAME || 'Detail Guardz';
  const label = type === 'email' ? 'Email Address' : 'Phone Number';
  const body = `
    <p>Hi,</p>
    <p>We received a request to update the <strong>${label}</strong> on your ${storeName} account.</p>
    <p>Please use the following verification code to confirm this change:</p>
    <div style="text-align: center; margin: 30px 0;">
      <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #1E3A5F; background: #f0f6ff; padding: 10px 20px; border-radius: 4px; border: 1px dashed #2E86AB;">
        ${otp}
      </span>
    </div>
    <p>This code will expire in 10 minutes. If you did not request this, please ignore this email and your account details will remain unchanged.</p>
    <p>Best regards,<br>The ${storeName} Team</p>
  `;

  return sendEmail({
    to: email,
    subject: `Confirm Your New ${label} — ${otp}`,
    html: wrapEmail('Security Verification', 'Action Required', body)
  });
}

export async function sendPasswordChangedEmail(email, firstName) {
  const storeName = process.env.STORE_NAME || 'Detail Guardz';
  const body = `
    <p>Hi ${firstName || 'Value Customer'},</p>
    <p>This is a confirmation that the password for your ${storeName} account has been successfully changed.</p>
    <div class="highlight-box">
      <p>If you made this change, you can safely ignore this email.</p>
      <p><strong>If you did NOT make this change, please contact our support team immediately.</strong></p>
    </div>
    <p>Best regards,<br>The ${storeName} Team</p>
  `;

  return sendEmail({
    to: email,
    subject: `Your ${storeName} Password has been changed`,
    html: wrapEmail('Password Changed', 'Security Notification', body)
  });
}

export default {
  sendOrderConfirmationEmail,
  sendOrderShippedEmail,
  sendOrderDeliveredEmail,
  sendFulfillmentErrorAlert,
  sendTrackingUpdateEmail,
  sendOTPEmail,
  sendWelcomeEmail,
  sendStockAlertEmail,
  sendPasswordResetOTPEmail,
  sendPasswordChangedEmail
};
