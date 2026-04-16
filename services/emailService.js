'use strict';

/**
 * Email Notification Service
 * ───────────────────────────
 * PRIMARY: SendGrid HTTP API (port 443 — works on Render/all cloud platforms)
 * FALLBACK: SMTP via nodemailer (for local dev or platforms with open SMTP ports)
 *
 * Set SENDGRID_API_KEY env var to use HTTP API.
 * If not set, falls back to SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS.
 */

import dns from 'dns';
import { resolve4 } from 'dns/promises';
import nodemailer from 'nodemailer';
import logger from '../utils/logger.js';
import { formatCurrency } from '../utils/helpers.js';

// ── CRITICAL: Force IPv4 DNS resolution globally ───────────────────────────
dns.setDefaultResultOrder('ipv4first');

// ── SendGrid HTTP API sender ───────────────────────────────────────────────
async function sendViaSendGrid({ to, subject, html, text, attachments }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromName    = process.env.EMAIL_FROM_NAME    || 'Your Store';
  const fromAddress = process.env.EMAIL_FROM_ADDRESS || 'noreply@yourstore.com';

  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: fromAddress, name: fromName },
    subject,
    content: [
      { type: 'text/plain', value: text || html.replace(/<[^>]+>/g, '') },
      { type: 'text/html',  value: html }
    ]
  };

  // Add attachments if present
  if (attachments && attachments.length > 0) {
    const fs = await import('fs');
    const path = await import('path');
    payload.attachments = attachments.map(att => {
      const content = att.content || fs.readFileSync(att.path);
      return {
        content: Buffer.from(content).toString('base64'),
        filename: att.filename,
        type: att.contentType || 'application/octet-stream',
        disposition: 'attachment'
      };
    });
  }

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`SendGrid API error ${res.status}: ${errBody}`);
  }

  return { success: true, messageId: res.headers.get('x-message-id') || 'sg-sent' };
}

// ── SMTP Transporter (fallback for local dev) ──────────────────────────────
let _transporter = null;

async function createTransporter() {
  const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
  const smtpPort = parseInt(process.env.SMTP_PORT || '465');
  const isSecure = (smtpPort === 465);

  let connectHost = smtpHost;
  try {
    const ipv4Addresses = await resolve4(smtpHost);
    if (ipv4Addresses.length > 0) {
      connectHost = ipv4Addresses[0];
      logger.info(`DNS resolved ${smtpHost} → ${connectHost} (IPv4)`);
    }
  } catch (dnsErr) {
    logger.warn(`DNS resolve4 failed for ${smtpHost}, using hostname directly: ${dnsErr.message}`);
  }

  const transport = nodemailer.createTransport({
    host: connectHost,
    port: smtpPort,
    secure: isSecure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    pool: false,
    connectionTimeout: 30000,
    greetingTimeout: 15000,
    socketTimeout: 45000,
    tls: { servername: smtpHost, rejectUnauthorized: false, minVersion: 'TLSv1.2' },
    family: 4
  });

  logger.info(`SMTP transporter created: ${connectHost}:${smtpPort} (resolved from ${smtpHost}, secure=${isSecure})`);
  return transport;
}

async function getTransporter() {
  if (!_transporter) _transporter = await createTransporter();
  return _transporter;
}

// ── Base send function ─────────────────────────────────────────────────────
export async function sendEmail({ to, subject, html, text }) {
  const useSendGrid = !!process.env.SENDGRID_API_KEY;
  const maxRetries  = 2;
  const emailAttachments = arguments[0].attachments || [];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      let result;

      if (useSendGrid) {
        // ── SendGrid HTTP API (port 443 — never blocked) ──
        result = await sendViaSendGrid({ to, subject, html, text, attachments: emailAttachments });
      } else {
        // ── SMTP fallback (local dev) ──
        const transporter = await getTransporter();
        const fromName    = process.env.EMAIL_FROM_NAME    || 'Your Store';
        const fromAddress = process.env.EMAIL_FROM_ADDRESS || 'noreply@yourstore.com';
        const info = await transporter.sendMail({
          from: `"${fromName}" <${fromAddress}>`,
          to, subject, html,
          text: text || html.replace(/<[^>]+>/g, ''),
          attachments: emailAttachments
        });
        result = { success: true, messageId: info.messageId };
      }

      logger.info(`Email sent via ${useSendGrid ? 'SendGrid API' : 'SMTP'}: ${subject} → ${to} [${result.messageId}]`);
      return result;

    } catch (err) {
      logger.warn(`Email attempt ${attempt}/${maxRetries} failed (${useSendGrid ? 'SendGrid' : 'SMTP'}): ${err.message}`, { to, subject });

      if (attempt < maxRetries) {
        if (!useSendGrid) { _transporter = null; }
        logger.info('Retrying email send...');
        await new Promise(r => setTimeout(r, 2000));
      } else {
        logger.error(`Email send failed after ${maxRetries} attempts: ${err.message}`, { to, subject });
        return { success: false, error: err.message };
      }
    }
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
  const orderNumber = order.order_number || order.id;
  const email = order.customer_email || order.email;
  const storeWebsite = process.env.STORE_WEBSITE || 'https://detailguardz.com';
  
  // Tracking URL for guests and regular users
  const trackingLink = `${storeWebsite}/order-tracking?number=${orderNumber}&email=${encodeURIComponent(email)}`;

  const table = itemsTableHtml(order.items, order.subtotal, order.shipping_cost, order.tax_amount || order.tax, order.total);

  const body = `
    <div style="text-align: center; margin-bottom: 30px;">
      <h3 style="color: #2E86AB; margin: 0; font-size: 24px;">Thank you for your order!</h3>
      <p style="color: #666; margin: 8px 0 0; font-size: 16px;">We've received your payment and are getting your items ready for shipment.</p>
    </div>
    
    <div style="text-align: center; margin: 25px 0;">
      <a href="${trackingLink}" class="btn" style="background: #2E86AB; padding: 16px 32px; font-size: 16px;">📦 View Your Order Status</a>
      <p style="font-size: 13px; color: #94a3b8; margin-top: 10px;">Click the button above to track your order details any time.</p>
    </div>

    <div class="highlight-box">
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
        <div>
          <p class="label" style="text-transform: uppercase; font-size: 11px; margin-bottom: 5px;">Order Number</p>
          <p style="font-weight: 700; font-size: 16px; margin: 0;">#${orderNumber}</p>
        </div>
        <div style="text-align: right;">
          <p class="label" style="text-transform: uppercase; font-size: 11px; margin-bottom: 5px;">Order Date</p>
          <p style="font-weight: 500; font-size: 14px; margin: 0;">${new Date(order.created_at).toLocaleDateString('en-US', { dateStyle: 'long' })}</p>
        </div>
      </div>
      <div style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #e0e6ed;">
        <p class="label" style="text-transform: uppercase; font-size: 11px; margin-bottom: 5px;">Shipping To</p>
        <p style="font-size: 14px; margin: 0; line-height: 1.4;">
          <strong>${order.shipping_first_name} ${order.shipping_last_name}</strong><br>
          ${order.shipping_address1}${order.shipping_address2 ? ', ' + order.shipping_address2 : ''}<br>
          ${order.shipping_city}, ${order.shipping_state || order.shipping_province} ${order.shipping_zip || order.shipping_postal_code}
        </p>
      </div>
    </div>

    <p style="font-weight: 700; color: #1E3A5F; margin-bottom: 10px; border-bottom: 2px solid #f0f4f8; padding-bottom: 5px; font-size: 16px;">Order Summary</p>
    ${table}

    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; margin: 25px 0;">
      <p style="margin: 0; font-size: 13px; color: #475569; line-height: 1.5;">
        <strong>Guest Checkout Note:</strong> Since you checked out as a guest, please keep this email for your records. You can track your order using the link above or by entering your order number and email on our tracking page.
      </p>
    </div>

    <p style="font-size: 14px; color: #64748b;">
      If you have any questions, simply reply to this email or visit our <a href="${storeWebsite}/support">Support Center</a>.
    </p>
  `;

  const mailOptions = {
    to:      order.customer_email || order.email,
    subject: `Order Confirmation — #${orderNumber}`,
    html:    wrapEmail('Order Confirmed! 🎉', `Order #${orderNumber}`, body)
  };

  if (invoicePdf) {
    mailOptions.attachments = [{
      filename: `invoice-${orderNumber}.pdf`,
      path: invoicePdf
    }];
  }

  return sendEmail(mailOptions);
}

export async function sendOrderShippedEmail(order, tracking) {
  const firstName = order.shipping_first_name || 'Customer';
  const orderNumber = order.order_number || order.id;
  const estDelivery = tracking.estimatedDelivery
    ? new Date(tracking.estimatedDelivery).toLocaleDateString('en-US', { dateStyle: 'long', weekday: 'long' })
    : 'Pending update';

  // Specific logic for Amazon tracking links if available
  const trackingUrl = tracking.trackingUrl || `https://www.amazon.com/progress-tracker/package-tracking/${tracking.trackingNumber}`;

  const body = `
    <p>Hi ${firstName},</p>
    <p>Great news! Your order <strong>#${orderNumber}</strong> has been shipped and is on its way.</p>
    
    <div class="highlight-box" style="background: #f0f9ff; border-left: 5px solid #0ea5e9;">
      <div style="display: grid; grid-template-columns: 1fr; gap: 10px;">
        <p style="margin: 0;"><span class="label">Status:</span> <strong style="color: #0369a1;">SHIPPED</strong></p>
        <p style="margin: 0;"><span class="label">Carrier:</span> ${tracking.carrier || 'Amazon Logistics'}</p>
        <p style="margin: 0;"><span class="label">Tracking ID:</span> <strong>${tracking.trackingNumber}</strong></p>
        <p style="margin: 0;"><span class="label">Est. Delivery:</span> <strong style="color: #1e40af;">${estDelivery}</strong></p>
      </div>
    </div>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${trackingUrl}" class="btn" style="background: #0ea5e9; padding: 16px 32px; font-size: 16px;">📦 Track Your Package</a>
      <p style="font-size: 12px; color: #94a3b8; margin-top: 10px;">Click the button above to see real-time updates via Amazon Tracking</p>
    </div>

    <p style="font-weight: 700; color: #1E3A5F; border-bottom: 1px solid #f0f4f8; padding-bottom: 5px;">Shipping Address</p>
    <p style="font-size: 14px; color: #64748b; line-height: 1.5;">
       ${order.shipping_first_name} ${order.shipping_last_name}<br>
       ${order.shipping_address1}${order.shipping_address2 ? ', ' + order.shipping_address2 : ''}<br>
       ${order.shipping_city}, ${order.shipping_state || order.shipping_province} ${order.shipping_zip || order.shipping_postal_code}
    </p>

    <p style="font-size: 13px; color: #64748b; margin-top: 30px;">
      Please note that it may take 24-48 hours for the tracking information to update.
    </p>
  `;

  return sendEmail({
    to:      order.customer_email || order.email,
    subject: `Your Order #${orderNumber} Has Shipped! 🚚`,
    html:    wrapEmail('Your Package is Moving! 🚚', `Order #${orderNumber}`, body)
  });
}

export async function sendOrderDeliveredEmail(order) {
  const firstName  = order.shipping_first_name || order.first_name || 'Customer';
  const email      = order.customer_email || order.cust_email || order.email;
  const storeName  = process.env.STORE_NAME    || 'Detail Guardz';
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
    to:      email,
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
    <div style="text-align: center; margin-bottom: 25px;">
      <h3 style="color: #1E3A5F; margin: 0; font-size: 20px;">Email Verification</h3>
      <p style="color: #666; margin: 8px 0 0; font-size: 15px;">Please use the following code to authenticate your email address and continue with your request.</p>
    </div>
    
    <div style="text-align: center; margin: 30px 0;">
      <span style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #1E3A5F; background: #f8fafc; padding: 16px 32px; border-radius: 12px; border: 2px solid #e2e8f0; display: inline-block;">
        ${otp}
      </span>
    </div>
    
    <div class="highlight-box">
      <p style="margin: 0; font-size: 13px; color: #475569; line-height: 1.5;">
        <strong>Why did I receive this?</strong> This code is required to verify your identity for actions like account creation, guest checkout, or security updates. This code will expire in 10 minutes.
      </p>
    </div>

    <p style="font-size: 14px; color: #64748b; margin-top: 20px;">
      If you did not request this code, please ignore this email. No changes have been made to your account.
    </p>
    
    <p style="font-size: 14px; color: #64748b;">Best regards,<br>The ${storeName} Team</p>
  `;

  return sendEmail({
    to: email,
    subject: `Your Verification Code: ${otp}`,
    html: wrapEmail('Security Verification', 'Action Required', body)
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

export async function sendBulkStockAlertEmail(alerts) {
  const adminEmail = process.env.ADMIN_ALERT_EMAIL || 'k7391356@gmail.com';
  if (!alerts || alerts.length === 0) return;

  // Group alerts by region
  const usaAlerts = alerts.filter(a => (a.region || '').toLowerCase() === 'us' || (a.region || '').toLowerCase() === 'usa');
  const caAlerts = alerts.filter(a => (a.region || '').toLowerCase() === 'ca' || (a.region || '').toLowerCase() === 'canada');
  const otherAlerts = alerts.filter(a => {
    const r = (a.region || '').toLowerCase();
    return r !== 'us' && r !== 'usa' && r !== 'ca' && r !== 'canada';
  });

  const buildSection = (title, items, color) => {
    if (items.length === 0) return '';
    const rows = items.map(a => `
      <div style="border-left: 4px solid ${color}; padding: 10px 15px; margin-bottom: 10px; background: #f9fafb; border-radius: 4px;">
        <p style="margin: 0; font-weight: 600; color: #1E3A5F;">${a.productName}</p>
        <p style="margin: 4px 0 0; font-size: 13px; color: #64748b;">SKU: ${a.sku || 'N/A'} | Stock: <strong style="color: ${color};">${a.currentStock}</strong></p>
      </div>
    `).join('');
    return `
      <h3 style="color: ${color}; margin-top: 25px; border-bottom: 2px solid #eee; padding-bottom: 8px;">${title}</h3>
      ${rows}
    `;
  };

  const bodyContent = `
    <p>The following items have reached critical stock levels and require attention:</p>
    ${buildSection('🇺🇸 USA Inventory (Amazon FBA)', usaAlerts, '#dc2626')}
    ${buildSection('🇨🇦 Canada Inventory (Shippo)', caAlerts, '#dc2626')}
    ${buildSection('🌐 Other Regions', otherAlerts, '#dc2626')}
    <p style="margin-top: 30px; font-size: 13px; color: #94a3b8; border-top: 1px solid #eee; pt: 15px;">
      This is an automated consolidated alert from the Nordica Inventory System.
    </p>
  `;

  // We send separate emails for USA and Canada if the user wants different emails for each region
  // "usa different email and canda different email"
  
  if (usaAlerts.length > 0) {
    const usaEmail = process.env.USA_ADMIN_EMAIL || adminEmail;
    await sendEmail({
      to: usaEmail,
      subject: `[INVENTORY] USA Stock Alert — ${usaAlerts.length} items`,
      html: wrapEmail('USA Stock Alert 🇺🇸', 'Inventory Management', `
        <p>The following items are out of stock in the <strong>USA region</strong>:</p>
        ${buildSection('', usaAlerts, '#dc2626')}
      `)
    });
  }

  if (caAlerts.length > 0) {
    const caEmail = process.env.CA_ADMIN_EMAIL || adminEmail;
    await sendEmail({
      to: caEmail,
      subject: `[INVENTORY] Canada Stock Alert — ${caAlerts.length} items`,
      html: wrapEmail('Canada Stock Alert 🇨🇦', 'Inventory Management', `
        <p>The following items are out of stock in the <strong>Canada region</strong>:</p>
        ${buildSection('', caAlerts, '#dc2626')}
      `)
    });
  }
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
  const email     = order.customer_email || order.cust_email || order.email;
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

export async function sendBackInStockEmail(email, productName, currentStock, productId) {
  const storeUrl = process.env.STORE_WEBSITE || 'https://detailguardz.com';
  const productUrl = `${storeUrl}/products/${productId}`; // Assuming ID works or we can use slug

  const body = `
    <div style="text-align: center; margin-bottom: 25px;">
      <span style="background: #dcfce7; color: #166534; padding: 6px 16px; border-radius: 20px; font-size: 12px; font-weight: 700; text-transform: uppercase;">Back In Stock</span>
    </div>
    <p>Hi there,</p>
    <p>Good news! The item you've been waiting for is back in stock and ready to ship.</p>
    
    <div class="highlight-box" style="text-align: center;">
      <h3 style="margin: 0; color: #1E3A5F;">${productName}</h3>
      <p style="color: #666; margin: 10px 0;">We currently have <strong>${currentStock}</strong> available in our warehouse.</p>
      <a href="${productUrl}" class="btn" style="margin-top: 10px;">✨ Shop Now Before It Sells Out Again</a>
    </div>

    <p style="font-size: 13px; color: #64748b;">
      You received this because you signed up to be notified when this item became available.
    </p>
  `;

  return sendEmail({
    to: email,
    subject: `${productName} is Back in Stock! 🎉`,
    html: wrapEmail('It\'s Back! 🎉', 'Restock Notification', body)
  });
}

export async function sendPasswordChangedEmail(email, firstName) {
  const storeName = process.env.STORE_NAME || 'Detail Guardz';
  const body = `
    <p>Hi ${firstName},</p>
    <p>This is a confirmation that the password for your <strong>${storeName}</strong> account has been successfully changed.</p>
    <div class="highlight-box">
      <p>If you made this change, you can safely ignore this email.</p>
      <p><strong>If you did NOT change your password</strong>, please contact our support team immediately at 
         <a href="mailto:${process.env.STORE_SUPPORT_EMAIL || 'support@detailguardz.com'}">${process.env.STORE_SUPPORT_EMAIL || 'support@detailguardz.com'}</a>.</p>
    </div>
    <p>Best regards,<br>The ${storeName} Team</p>
  `;

  return sendEmail({
    to: email,
    subject: `Password Changed Successfully — ${storeName}`,
    html: wrapEmail('Password Updated', 'Security Notification', body)
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
  sendBulkStockAlertEmail,
  sendBackInStockEmail,
  sendPasswordResetOTPEmail,
  sendPasswordChangedEmail
};
