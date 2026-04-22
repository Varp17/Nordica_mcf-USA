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
async function sendViaSendGrid({ to, subject, html, text, attachments, bcc }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromName    = process.env.EMAIL_FROM_NAME    || 'Your Store';
  const fromAddress = process.env.EMAIL_FROM_ADDRESS || 'noreply@yourstore.com';

  const personalization = { to: [{ email: to }] };
  if (bcc) {
    personalization.bcc = [{ email: bcc }];
  }

  const payload = {
    personalizations: [personalization],
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

  const transport = nodemailer.createTransport({
    host: smtpHost,
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

  logger.info(`SMTP transporter created: ${smtpHost}:${smtpPort} (secure=${isSecure})`);
  return transport;
}

async function getTransporter() {
  if (!_transporter) _transporter = await createTransporter();
  return _transporter;
}

// ── Base send function ─────────────────────────────────────────────────────
export async function sendEmail({ to, subject, html, text, bcc }) {
  const useSendGrid = !!process.env.SENDGRID_API_KEY;
  const maxRetries  = 2;
  const emailAttachments = arguments[0].attachments || [];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      let result;

      if (useSendGrid) {
        // ── SendGrid HTTP API (port 443 — never blocked) ──
        result = await sendViaSendGrid({ to, subject, html, text, attachments: emailAttachments, bcc });
      } else {
        // ── SMTP fallback (local dev) ──
        const transporter = await getTransporter();
        const fromName    = process.env.EMAIL_FROM_NAME    || 'Your Store';
        const fromAddress = process.env.EMAIL_FROM_ADDRESS || 'noreply@yourstore.com';
        const info = await transporter.sendMail({
          from: `"${fromName}" <${fromAddress}>`,
          to, subject, html, bcc,
          text: text || html.replace(/<[^>]+>/g, ''),
          attachments: emailAttachments
        });
        result = { success: true, messageId: info.messageId };
      }

      const logId = result.messageId ? (result.messageId.includes('<') ? result.messageId : `[${result.messageId}]`) : '[sg-sent]';
      logger.info(`Email sent via ${useSendGrid ? 'SendGrid API' : 'SMTP'}: ${subject} → ${to} ${logId}`);
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
  const storeWebsite = process.env.STORE_WEBSITE || 'https://detailguardz.com';
  const apiBase = process.env.API_BASE_URL || 'http://localhost:5000';

  const rows = (items || []).map(item => {
    const productName = item.product_name_at_purchase || item.product_name || 'Product';
    const imageUrl = item.image_url_at_purchase || item.image || '';
    const absoluteImg = imageUrl.startsWith('http') ? imageUrl : `${apiBase}${imageUrl.startsWith('/') ? '' : '/'}${imageUrl}`;
    const productUrl = item.slug ? `${storeWebsite}/products/${item.slug}` : `${storeWebsite}/products`;
    const price = parseFloat(item.price_at_purchase || item.unit_price || 0);
    const quantity = parseInt(item.quantity || 1);

    return `
    <tr>
      <td style="padding: 10px 0; width: 60px;">
        <img src="${absoluteImg}" alt="${productName}" style="width: 50px; height: 50px; object-fit: cover; border-radius: 4px; background: #f9fafb;" />
      </td>
      <td style="padding: 10px 12px;">
        <div style="font-weight: 600; color: #333;">
          <a href="${productUrl}" style="color: #1a6a8a; text-decoration: none;">${productName}</a>
        </div>
        <div style="font-size: 11px; color: #888;">SKU: ${item.sku || 'N/A'}</div>
      </td>
      <td style="text-align:center;">${quantity}</td>
      <td style="text-align:right;">${formatCurrency(price)}</td>
      <td style="text-align:right;">${formatCurrency(price * quantity)}</td>
    </tr>`;
  }).join('');

  return `
    <table class="order-table" style="width: 100%; border-collapse: collapse; margin-top: 20px;">
      <thead><tr style="border-bottom: 2px solid #edf2f7;">
        <th colspan="2" style="text-align: left; padding-bottom: 10px;">Item</th>
        <th style="text-align:center; padding-bottom: 10px;">Qty</th>
        <th style="text-align:right; padding-bottom: 10px;">Price</th>
        <th style="text-align:right; padding-bottom: 10px;">Amount</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot style="border-top: 2px solid #edf2f7;">
        <tr class="totals-row"><td colspan="4" style="padding-top: 15px;">Subtotal</td><td style="text-align:right; padding-top: 15px;">${formatCurrency(parseFloat(subtotal || 0))}</td></tr>
        <tr class="totals-row"><td colspan="4">Shipping</td><td style="text-align:right;">${formatCurrency(parseFloat(shipping || 0))}</td></tr>
        <tr class="totals-row"><td colspan="4">Tax</td><td style="text-align:right;">${formatCurrency(parseFloat(tax || 0))}</td></tr>
        <tr class="totals-row" style="font-size:16px;"><td colspan="4"><strong>Order Total</strong></td>
          <td style="text-align:right;"><strong>${formatCurrency(parseFloat(total || 0))}</strong></td></tr>
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

export async function sendFulfillmentOrderSubmittedEmail(order) {
  const firstName = order.shipping_first_name || 'Customer';
  const orderNumber = order.order_number || order.id;
  const storeWebsite = process.env.STORE_WEBSITE || 'https://detailguardz.com';

  const body = `
    <p>Hi ${firstName},</p>
    <p>Great news! Your order <strong>#${orderNumber}</strong> has been processed and is currently being prepared for shipment at our fulfillment center.</p>
    
    <div class="highlight-box" style="background: #f0fdf4; border-left: 5px solid #22c55e;">
      <p style="margin: 0;"><span class="label">Status:</span> <strong style="color: #15803d;">PROCESSING AT WAREHOUSE</strong></p>
      <p style="margin: 0; font-size: 13px; color: #64748b; margin-top: 5px;">Our team is picking and packing your items right now.</p>
    </div>

    <p>You will receive another email with your tracking number as soon as your package leaves the warehouse. This usually takes 1-2 business days.</p>

    <div style="text-align: center; margin: 25px 0;">
      <a href="${storeWebsite}/order-tracking?number=${orderNumber}&email=${encodeURIComponent(order.customer_email || order.email)}" class="btn">View Order Details</a>
    </div>

    <p style="font-size: 14px; color: #64748b;">
      If you have any questions in the meantime, simply reply to this email.
    </p>
  `;

  return sendEmail({
    to:      order.customer_email || order.email,
    subject: `Processing Update — Order #${orderNumber}`,
    html:    wrapEmail('Preparing Your Order! 📦', `Order #${orderNumber}`, body)
  });
}

export async function sendOrderShippedEmail(order, tracking) {
  const firstName = order.shipping_first_name || 'Customer';
  const orderNumber = order.order_number || order.id;
  const estDelivery = tracking.estimatedDelivery
    ? new Date(tracking.estimatedDelivery).toLocaleDateString('en-US', { dateStyle: 'long', weekday: 'long' })
    : 'Pending update';

  // Tracking URL for guests and regular users
  const trackingUrl = tracking.trackingUrl || `https://www.amazon.com/progress-tracker/package-tracking/${tracking.trackingNumber}`;

  const table = itemsTableHtml(order.items, order.subtotal, order.shipping_cost, order.tax, order.total);

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
    </div>

    <p style="font-weight: 700; color: #1E3A5F; margin-bottom: 10px; border-bottom: 2px solid #f0f4f8; padding-bottom: 5px; font-size: 16px;">What's in the Box</p>
    ${table}

    <p style="font-weight: 700; color: #1E3A5F; border-bottom: 1px solid #f0f4f8; padding-bottom: 5px; margin-top: 30px;">Shipping Address</p>
    <p style="font-size: 14px; color: #64748b; line-height: 1.5;">
       ${order.shipping_first_name} ${order.shipping_last_name}<br>
       ${order.shipping_address1}${order.shipping_address2 ? ', ' + order.shipping_address2 : ''}<br>
       ${order.shipping_city}, ${order.shipping_state || order.shipping_province} ${order.shipping_zip || order.shipping_postal_code}
    </p>

    <p style="font-size: 13px; color: #64748b; margin-top: 30px;">
      Please note that it may take 24-48 hours for the tracking information to update.
    </p>
  `;

  const adminEmail = process.env.ADMIN_ALERT_EMAIL || process.env.STORE_SUPPORT_EMAIL || 'k7391356@gmail.com';
  return sendEmail({
    to:      order.customer_email || order.email,
    bcc:     adminEmail,
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

  const adminEmail = process.env.ADMIN_ALERT_EMAIL || process.env.STORE_SUPPORT_EMAIL || 'k7391356@gmail.com';
  return sendEmail({
    to:      email,
    bcc:     adminEmail,
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
    const result = await sendEmail({
      to: usaEmail,
      subject: `[INVENTORY] USA Stock Alert — ${usaAlerts.length} items`,
      html: wrapEmail('USA Stock Alert 🇺🇸', 'Inventory Management', `
        <p>The following items are out of stock in the <strong>USA region</strong>:</p>
        ${buildSection('', usaAlerts, '#dc2626')}
      `)
    });
    const cleanId = result.messageId ? result.messageId.replace(/[<>]/g, '') : 'sg-sent';
    logger.info(`USA Stock Alert — ${usaAlerts.length} items → ${usaEmail} [USA-ALERT-${cleanId}]`);
  }

  if (caAlerts.length > 0) {
    const caEmail = process.env.CA_ADMIN_EMAIL || adminEmail;
    const result = await sendEmail({
      to: caEmail,
      subject: `[INVENTORY] Canada Stock Alert — ${caAlerts.length} items`,
      html: wrapEmail('Canada Stock Alert 🇨🇦', 'Inventory Management', `
        <p>The following items are out of stock in the <strong>Canada region</strong>:</p>
        ${buildSection('', caAlerts, '#dc2626')}
      `)
    });
    const cleanId = result.messageId ? result.messageId.replace(/[<>]/g, '') : 'sg-sent';
    logger.info(`Canada Stock Alert — ${caAlerts.length} items → ${caEmail} [CA-ALERT-${cleanId}]`);
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

export async function sendNewOrderAdminAlert(order) {
  const defaultAdminEmail = process.env.ADMIN_ALERT_EMAIL || process.env.STORE_SUPPORT_EMAIL || 'k7391356@gmail.com';
  const orderNum = order.order_number || order.orderNumber || order.id;
  const country = (order.country || 'US').toUpperCase();
  const customerName = `${order.shipping_first_name || ''} ${order.shipping_last_name || ''}`.trim() || 'Guest Customer';

  // Region-specific routing — send to the right admin inbox
  const isCanada = country === 'CA';
  const regionEmail = isCanada
    ? (process.env.CA_ADMIN_EMAIL || defaultAdminEmail)
    : (process.env.USA_ADMIN_EMAIL || defaultAdminEmail);
  
  const regionFlag = isCanada ? '🇨🇦' : '🇺🇸';
  const regionLabel = isCanada ? 'Canada' : 'USA';
  const fulfillmentChannel = isCanada ? 'Shippo (Manual Label)' : 'Amazon MCF (Auto-Fulfilled)';
  const badgeColor = isCanada ? 'background: #fef3c7; color: #92400e;' : 'background: #dbeafe; color: #1e40af;';
  const accentColor = isCanada ? '#dc2626' : '#2563eb';
  const currencyLabel = order.currency || (isCanada ? 'CAD' : 'USD');

  // Build shipping address line
  const shippingLine = [
    order.shipping_address1,
    order.shipping_address2,
    order.shipping_city,
    order.shipping_state || order.shipping_province,
    order.shipping_zip || order.shipping_postal_code
  ].filter(Boolean).join(', ');

  // Build items summary if available
  let itemsSummary = '';
  if (order.items && order.items.length > 0) {
    const itemRows = order.items.map(item => {
      const name = item.product_name || item.product_name_at_purchase || 'Product';
      const sku = item.actual_sku || item.sku || 'N/A';
      const qty = item.quantity || 1;
      const price = parseFloat(item.unit_price || item.price_at_purchase || 0);
      return `<tr>
        <td style="padding: 6px 10px; border-bottom: 1px solid #f0f4f8; font-size: 13px;">${name}</td>
        <td style="padding: 6px 10px; border-bottom: 1px solid #f0f4f8; font-size: 12px; color: #64748b;">${sku}</td>
        <td style="padding: 6px 10px; border-bottom: 1px solid #f0f4f8; text-align: center;">${qty}</td>
        <td style="padding: 6px 10px; border-bottom: 1px solid #f0f4f8; text-align: right;">${formatCurrency(price)}</td>
      </tr>`;
    }).join('');

    itemsSummary = `
      <p style="font-weight: 700; color: #1E3A5F; margin: 20px 0 8px; font-size: 14px;">Items Ordered</p>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead><tr style="border-bottom: 2px solid #e2e8f0;">
          <th style="text-align: left; padding: 6px 10px; font-size: 12px; color: #64748b;">Product</th>
          <th style="text-align: left; padding: 6px 10px; font-size: 12px; color: #64748b;">SKU</th>
          <th style="text-align: center; padding: 6px 10px; font-size: 12px; color: #64748b;">Qty</th>
          <th style="text-align: right; padding: 6px 10px; font-size: 12px; color: #64748b;">Price</th>
        </tr></thead>
        <tbody>${itemRows}</tbody>
      </table>
    `;
  }
  
  const body = `
    <div style="text-align: center; margin-bottom: 20px;">
      <span style="${badgeColor} padding: 6px 16px; border-radius: 20px; font-size: 13px; font-weight: 700; text-transform: uppercase;">${regionFlag} New ${regionLabel} Order</span>
    </div>
    <p>Hi Admin,</p>
    <p>A new <strong>${regionLabel}</strong> order has been successfully paid and requires ${isCanada ? '<strong>manual fulfillment via Shippo Dashboard</strong>' : 'fulfillment (auto-submitted to Amazon MCF)'}.</p>
    
    <div class="highlight-box" style="border-left-color: ${accentColor};">
      <h3 style="margin: 0; color: #1E3A5F;">${regionFlag} Order #${orderNum}</h3>
      <p style="margin: 10px 0; font-size: 14px;">
        <strong>Customer:</strong> ${customerName}<br>
        <strong>Email:</strong> ${order.customer_email || 'N/A'}<br>
        <strong>Phone:</strong> ${order.shipping_phone || 'N/A'}<br>
        <strong>Region:</strong> ${regionLabel} (${country})<br>
        <strong>Fulfillment:</strong> ${fulfillmentChannel}<br>
        <strong>Shipping Method:</strong> ${order.shipping_speed || 'Standard'}<br>
        <strong>Total:</strong> <span style="font-size: 18px; font-weight: 700; color: ${accentColor};">$${parseFloat(order.total || 0).toFixed(2)} ${currencyLabel}</span>
      </p>
      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 15px 0;">
      <p style="margin: 0; font-size: 13px; color: #64748b;">
        <strong>Ship To:</strong> ${shippingLine}
      </p>
    </div>

    ${itemsSummary}

    <div style="margin-top: 20px; padding: 15px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
      <table style="width: 100%; font-size: 14px;">
        <tr><td style="color: #64748b;">Subtotal</td><td style="text-align: right; font-weight: 600;">$${parseFloat(order.subtotal || 0).toFixed(2)}</td></tr>
        <tr><td style="color: #64748b;">Shipping</td><td style="text-align: right; font-weight: 600;">$${parseFloat(order.shipping_cost || 0).toFixed(2)}</td></tr>
        <tr><td style="color: #64748b;">Tax</td><td style="text-align: right; font-weight: 600;">$${parseFloat(order.tax || order.tax_amount || 0).toFixed(2)}</td></tr>
        <tr><td style="color: #1E3A5F; font-weight: 700; padding-top: 10px; border-top: 2px solid #e2e8f0;">Total</td>
            <td style="text-align: right; font-weight: 700; font-size: 16px; color: ${accentColor}; padding-top: 10px; border-top: 2px solid #e2e8f0;">$${parseFloat(order.total || 0).toFixed(2)} ${currencyLabel}</td></tr>
      </table>
    </div>

    ${isCanada ? `
    <div style="margin-top: 20px; padding: 12px 16px; background: #fef3c7; border-radius: 6px; border: 1px solid #fbbf24;">
      <p style="margin: 0; font-size: 13px; color: #92400e; font-weight: 600;">⚠️ ACTION REQUIRED: This is a Canadian order. Please purchase a shipping label from the <a href="https://apps.goshippo.com/orders" style="color: #92400e; font-weight: 700;">Shippo Dashboard</a> to fulfill this order.</p>
    </div>
    ` : ''}

    <div style="text-align: center; margin: 25px 0;">
      <a href="${process.env.ADMIN_PORTAL_URL || '#'}" class="btn" style="background: ${accentColor}; padding: 14px 28px;">🚀 Open Admin Dashboard</a>
    </div>
  `;

  return sendEmail({
    to: regionEmail,
    subject: `${regionFlag} New ${regionLabel} Order: #${orderNum} — $${parseFloat(order.total || 0).toFixed(2)} ${currencyLabel}`,
    html: wrapEmail(`${regionFlag} New ${regionLabel} Order: #${orderNum}`, 'Admin Notification', body)
  }).then(() => {
    logger.info(`📧 Admin Notification Sent for ${regionLabel} Order #${orderNum} → ${regionEmail}`);
  }).catch(err => {
    logger.error(`❌ Failed to send Admin Notification for #${orderNum}: ${err.message}`);
  });
}

export async function sendNewTicketAdminAlert(ticket) {
  const adminEmail = process.env.ADMIN_ALERT_EMAIL || process.env.STORE_SUPPORT_EMAIL || 'info@nordicaplastics.ca';
  const ticketNum = ticket.ticket_number;
  const region = (ticket.country || 'US').toUpperCase();
  
  const body = `
    <div style="text-align: center; margin-bottom: 20px;">
      <span style="background: #fef3c7; color: #92400e; padding: 6px 16px; border-radius: 20px; font-size: 12px; font-weight: 700; text-transform: uppercase;">New Support Inquiry</span>
    </div>
    <p>Hi Support Team,</p>
    <p>A new customer inquiry has been received and requires your <strong>immediate attention</strong>.</p>
    
    <div class="highlight-box">
      <h3 style="margin: 0; color: #1E3A5F;">Ticket ${ticketNum}</h3>
      <p style="margin: 10px 0; font-size: 14px;">
        <strong>Customer Name:</strong> ${ticket.name}<br>
        <strong>Email Address:</strong> ${ticket.email}<br>
        <strong>Region:</strong> ${region}<br>
        <strong>Subject:</strong> ${ticket.subject}
      </p>
      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 15px 0;">
      <p style="margin: 0; font-size: 14px; color: #333; line-height: 1.6;">
        <strong>Message Preview:</strong><br>
        <span style="font-style: italic; color: #555;">"${ticket.message.length > 200 ? ticket.message.substring(0, 200) + '...' : ticket.message}"</span>
      </p>
    </div>

    <div style="text-align: center; margin: 25px 0;">
      <a href="${process.env.ADMIN_PORTAL_URL || '#'}admin/queries" class="btn" style="background: #1E3A5F; padding: 14px 28px;">🚀 View Ticket & Respond</a>
    </div>

    <p style="font-size: 13px; color: #64748b; border-top: 1px solid #f0f4f8; padding-top: 15px;">
      Responding to this query promptly helps maintain our commitment to excellent customer service.
    </p>
  `;

  return sendEmail({
    to: adminEmail,
    subject: `[NEW TICKET] ${ticketNum} — ${ticket.subject} (${region})`,
    html: wrapEmail('Customer Inquiry Received', 'Immediate Action Required', body)
  }).catch(err => {
    logger.error(`❌ Failed to send Admin Ticket Alert for ${ticketNum}: ${err.message}`);
  });
}

export async function sendPaymentFailureEmail(order, errorMessage) {
  const firstName = order.shipping_first_name || 'Customer';
  const orderNumber = order.order_number || order.id;
  const storeWebsite = process.env.STORE_WEBSITE || 'https://detailguardz.com';

  const body = `
    <p>Hi ${firstName},</p>
    <p>We were unable to process the payment for your order <strong>#${orderNumber}</strong>.</p>
    
    <div class="highlight-box" style="background: #fef2f2; border-left: 5px solid #ef4444;">
      <p style="margin: 0;"><span class="label">Reason:</span> <strong style="color: #991b1b;">${errorMessage || 'Payment transaction failed'}</strong></p>
      <p style="margin: 0; font-size: 13px; color: #7f1d1d; margin-top: 5px;">Don't worry, your items have been reserved, but we can't ship them until payment is successful.</p>
    </div>
    
    <p>Please try placing your order again or use a different payment method. If you continue to have trouble, our support team is here to help.</p>
    
    <div style="text-align: center; margin: 25px 0;">
      <a href="${storeWebsite}/checkout" class="btn" style="background: #ef4444;">🛒 Return to Checkout</a>
    </div>
    
    <p style="font-size: 14px; color: #64748b;">
      If you believe this is an error, please reply to this email.
    </p>
  `;

  return sendEmail({
    to: order.customer_email || order.email,
    subject: `Payment Issue — Order #${orderNumber}`,
    html: wrapEmail('Payment Not Processed', 'Action Required', body)
  });
}

/**
 * STALE ORDER ALERT — Paid orders not fulfilled after 6+ hours
 * Consolidates multiple orders into a single email per region.
 */
export async function sendStaleOrderAlert(orders, region = 'US') {
  const defaultAdminEmail = process.env.ADMIN_ALERT_EMAIL || process.env.STORE_SUPPORT_EMAIL || 'k7391356@gmail.com';
  const isCanada = region === 'CA';
  const regionEmail = isCanada
    ? (process.env.CA_ADMIN_EMAIL || defaultAdminEmail)
    : (process.env.USA_ADMIN_EMAIL || defaultAdminEmail);
  
  const regionFlag = isCanada ? '🇨🇦' : '🇺🇸';
  const regionLabel = isCanada ? 'Canada' : 'USA';
  const fulfillmentChannel = isCanada ? 'Shippo' : 'Amazon MCF';
  const accentColor = '#dc2626';

  const orderRows = orders.map(o => {
    const hoursSincePaid = o.paid_at 
      ? Math.round((Date.now() - new Date(o.paid_at).getTime()) / (1000 * 60 * 60)) 
      : '?';
    const customerName = `${o.shipping_first_name || ''} ${o.shipping_last_name || ''}`.trim() || 'Guest';
    const location = [o.shipping_city, o.shipping_state || o.shipping_province].filter(Boolean).join(', ');
    
    return `<tr>
      <td style="padding: 10px 12px; border-bottom: 1px solid #f0f4f8; font-weight: 600;">#${o.order_number}</td>
      <td style="padding: 10px 12px; border-bottom: 1px solid #f0f4f8;">${customerName}</td>
      <td style="padding: 10px 12px; border-bottom: 1px solid #f0f4f8;">${o.customer_email || 'N/A'}</td>
      <td style="padding: 10px 12px; border-bottom: 1px solid #f0f4f8; text-align: right; font-weight: 600;">$${parseFloat(o.total || 0).toFixed(2)} ${o.currency || (isCanada ? 'CAD' : 'USD')}</td>
      <td style="padding: 10px 12px; border-bottom: 1px solid #f0f4f8; text-align: center; color: ${accentColor}; font-weight: 700;">${hoursSincePaid}h</td>
      <td style="padding: 10px 12px; border-bottom: 1px solid #f0f4f8; font-size: 12px; color: #64748b;">${o.fulfillment_status || 'pending'}</td>
      <td style="padding: 10px 12px; border-bottom: 1px solid #f0f4f8; font-size: 11px; color: #94a3b8; max-width: 150px; overflow: hidden; text-overflow: ellipsis;">${o.fulfillment_error || '—'}</td>
    </tr>`;
  }).join('');

  const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.total || 0), 0);

  const body = `
    <div style="text-align: center; margin-bottom: 20px;">
      <span style="background: #fef2f2; color: #991b1b; padding: 8px 20px; border-radius: 20px; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">⚠️ STALE ORDER ALERT</span>
    </div>
    <p>Hi Admin,</p>
    <p>The following <strong>${orders.length} ${regionLabel} order(s)</strong> have been <strong>PAID</strong> but are <strong>NOT yet fulfilled</strong> for over <strong>${regionLabel === 'Canada' ? '6' : '6'} hours</strong>. These orders require immediate attention.</p>
    
    <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 15px; margin: 20px 0;">
      <p style="margin: 0; font-size: 14px; color: #991b1b;">
        <strong>💰 Revenue at Risk:</strong> $${totalRevenue.toFixed(2)} across ${orders.length} order(s)<br>
        <strong>📦 Fulfillment Channel:</strong> ${fulfillmentChannel}<br>
        <strong>⏱️ Threshold:</strong> 6+ hours since payment
      </p>
    </div>

    <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin: 20px 0;">
      <thead>
        <tr style="background: #fef2f2; border-bottom: 2px solid #fecaca;">
          <th style="text-align: left; padding: 10px 12px; color: #991b1b;">Order</th>
          <th style="text-align: left; padding: 10px 12px; color: #991b1b;">Customer</th>
          <th style="text-align: left; padding: 10px 12px; color: #991b1b;">Email</th>
          <th style="text-align: right; padding: 10px 12px; color: #991b1b;">Total</th>
          <th style="text-align: center; padding: 10px 12px; color: #991b1b;">Waiting</th>
          <th style="text-align: left; padding: 10px 12px; color: #991b1b;">Status</th>
          <th style="text-align: left; padding: 10px 12px; color: #991b1b;">Error</th>
        </tr>
      </thead>
      <tbody>${orderRows}</tbody>
    </table>

    <div style="background: #fffbeb; border: 1px solid #fbbf24; border-radius: 8px; padding: 15px; margin: 20px 0;">
      <p style="margin: 0; font-size: 13px; color: #92400e;">
        <strong>🔧 What to do:</strong><br>
        ${isCanada 
          ? '• Check the <a href="https://apps.goshippo.com/orders" style="color: #92400e; font-weight: 700;">Shippo Dashboard</a> for these orders<br>• Purchase shipping labels if not already done<br>• If the order shows an error, check the product inventory and address validity' 
          : '• Check your <a href="https://sellercentral.amazon.com/orders-v3" style="color: #92400e; font-weight: 700;">Amazon Seller Central</a> for MCF status<br>• Verify SKUs are in FBA stock<br>• Try manual fulfillment retry from the Admin Dashboard<br>• If SP-API is throttled, wait and retry in 30 minutes'
        }
      </p>
    </div>

    <div style="text-align: center; margin: 25px 0;">
      <a href="${process.env.ADMIN_PORTAL_URL || '#'}" class="btn" style="background: ${accentColor}; padding: 14px 28px;">🚀 Open Admin Dashboard</a>
    </div>
  `;

  return sendEmail({
    to: regionEmail,
    subject: `🚨 ${regionFlag} STALE ${regionLabel} ORDERS: ${orders.length} order(s) unfulfilled for 6h+ — $${totalRevenue.toFixed(2)} at risk`,
    html: wrapEmail(`${regionFlag} Stale Order Alert`, 'Immediate Action Required', body)
  });
}

/**
 * RETRY EXHAUSTED ALERT — MCF fulfillment failed after all retries
 * Critical: customer paid but we couldn't ship. May need manual intervention or refund.
 */
export async function sendRetryExhaustedAlert(order) {
  const defaultAdminEmail = process.env.ADMIN_ALERT_EMAIL || process.env.STORE_SUPPORT_EMAIL || 'k7391356@gmail.com';
  const isCanada = (order.country || '').toUpperCase() === 'CA';
  const regionEmail = isCanada
    ? (process.env.CA_ADMIN_EMAIL || defaultAdminEmail)
    : (process.env.USA_ADMIN_EMAIL || defaultAdminEmail);

  const regionFlag = isCanada ? '🇨🇦' : '🇺🇸';
  const regionLabel = isCanada ? 'Canada' : 'USA';
  const fulfillmentChannel = isCanada ? 'Shippo' : 'Amazon MCF';
  const customerName = `${order.shipping_first_name || ''} ${order.shipping_last_name || ''}`.trim() || 'Guest';
  const hoursSincePaid = order.paid_at 
    ? Math.round((Date.now() - new Date(order.paid_at).getTime()) / (1000 * 60 * 60)) 
    : '?';

  const body = `
    <div style="text-align: center; margin-bottom: 20px;">
      <span style="background: #7f1d1d; color: #ffffff; padding: 8px 20px; border-radius: 20px; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">🔴 CRITICAL: FULFILLMENT FAILED</span>
    </div>
    <p>Hi Admin,</p>
    <p>Order <strong>#${order.order_number}</strong> has <strong>exhausted all ${order.retry_count || 3} automatic retry attempts</strong> and could not be fulfilled via <strong>${fulfillmentChannel}</strong>.</p>
    <p style="color: #991b1b; font-weight: 600;">The customer has PAID but their order has NOT shipped. This requires immediate manual action or a refund.</p>
    
    <div class="highlight-box" style="border-left: 5px solid #7f1d1d; background: #fef2f2;">
      <h3 style="margin: 0; color: #7f1d1d;">${regionFlag} Order #${order.order_number}</h3>
      <p style="margin: 10px 0; font-size: 14px;">
        <strong>Customer:</strong> ${customerName}<br>
        <strong>Email:</strong> ${order.customer_email || 'N/A'}<br>
        <strong>Region:</strong> ${regionLabel}<br>
        <strong>Channel:</strong> ${fulfillmentChannel}<br>
        <strong>Shipping:</strong> ${order.shipping_speed || 'Standard'}<br>
        <strong>Total:</strong> <span style="font-size: 18px; font-weight: 700; color: #7f1d1d;">$${parseFloat(order.total || 0).toFixed(2)} ${order.currency || (isCanada ? 'CAD' : 'USD')}</span><br>
        <strong>Paid:</strong> ${order.paid_at ? new Date(order.paid_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown'} (${hoursSincePaid}h ago)<br>
        <strong>Retries:</strong> ${order.retry_count || 0} / 3 (ALL EXHAUSTED)
      </p>
      <hr style="border: 0; border-top: 1px solid #fecaca; margin: 15px 0;">
      <p style="margin: 0; font-size: 13px;">
        <strong>Last Error:</strong><br>
        <code style="background: #fff; padding: 8px; display: block; border-radius: 4px; font-size: 12px; color: #991b1b; margin-top: 5px; word-break: break-all;">${order.fulfillment_error || order.notes || 'No error details recorded'}</code>
      </p>
    </div>

    <div style="background: #fef3c7; border: 1px solid #fbbf24; border-radius: 8px; padding: 15px; margin: 20px 0;">
      <p style="margin: 0; font-size: 13px; color: #92400e; font-weight: 600;">
        📋 <strong>Recommended Actions:</strong>
      </p>
      <ol style="font-size: 13px; color: #92400e; margin: 10px 0 0; padding-left: 20px; line-height: 1.8;">
        ${isCanada ? `
        <li>Check the <a href="https://apps.goshippo.com/orders" style="color: #92400e; font-weight: 700;">Shippo Dashboard</a> for this order</li>
        <li>Verify shipping address is valid</li>
        <li>Try creating the Shippo order manually</li>
        <li>If unfulfillable, process a <strong>full refund</strong> via PayPal</li>
        ` : `
        <li>Check <a href="https://sellercentral.amazon.com/orders-v3" style="color: #92400e; font-weight: 700;">Amazon Seller Central</a> for FBA inventory of the SKU(s)</li>
        <li>Verify the SKU(s) exist and have stock in Amazon FBA</li>
        <li>Try creating the MCF order manually in Seller Central</li>
        <li>Check SP-API throttling / service health status</li>
        <li>If unfulfillable, process a <strong>full refund</strong> via PayPal and notify the customer</li>
        `}
        <li>Email the customer at <strong>${order.customer_email || 'N/A'}</strong> with an update</li>
      </ol>
    </div>

    <div style="text-align: center; margin: 25px 0;">
      <a href="${process.env.ADMIN_PORTAL_URL || '#'}" class="btn" style="background: #7f1d1d; padding: 14px 28px;">🚀 Open Admin Dashboard</a>
    </div>
  `;

  return sendEmail({
    to: regionEmail,
    subject: `🔴 CRITICAL: ${regionFlag} Order #${order.order_number} FAILED after ${order.retry_count || 3} retries — $${parseFloat(order.total || 0).toFixed(2)} needs manual action`,
    html: wrapEmail(`${regionFlag} Fulfillment Failure: #${order.order_number}`, 'CRITICAL — Manual Action Required', body)
  });
}

/**
 * CA LABEL REMINDER — Canadian orders submitted to Shippo but no label after 12h
 */
export async function sendCaLabelReminderAlert(orders) {
  const adminEmail = process.env.CA_ADMIN_EMAIL || process.env.ADMIN_ALERT_EMAIL || process.env.STORE_SUPPORT_EMAIL || 'k7391356@gmail.com';

  const orderRows = orders.map(o => {
    const hoursSincePaid = o.paid_at 
      ? Math.round((Date.now() - new Date(o.paid_at).getTime()) / (1000 * 60 * 60)) 
      : '?';
    const customerName = `${o.shipping_first_name || ''} ${o.shipping_last_name || ''}`.trim() || 'Guest';
    
    return `<tr>
      <td style="padding: 10px 12px; border-bottom: 1px solid #f0f4f8; font-weight: 600;">#${o.order_number}</td>
      <td style="padding: 10px 12px; border-bottom: 1px solid #f0f4f8;">${customerName}</td>
      <td style="padding: 10px 12px; border-bottom: 1px solid #f0f4f8; text-align: right; font-weight: 600;">$${parseFloat(o.total || 0).toFixed(2)} CAD</td>
      <td style="padding: 10px 12px; border-bottom: 1px solid #f0f4f8; text-align: center; color: #dc2626; font-weight: 700;">${hoursSincePaid}h</td>
      <td style="padding: 10px 12px; border-bottom: 1px solid #f0f4f8; font-size: 12px;">${o.shipping_speed || 'Standard'}</td>
    </tr>`;
  }).join('');

  const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.total || 0), 0);

  const body = `
    <div style="text-align: center; margin-bottom: 20px;">
      <span style="background: #fef3c7; color: #92400e; padding: 8px 20px; border-radius: 20px; font-size: 13px; font-weight: 700; text-transform: uppercase;">🇨🇦 LABEL PURCHASE REMINDER</span>
    </div>
    <p>Hi Admin,</p>
    <p>The following <strong>${orders.length} Canadian order(s)</strong> have been submitted to Shippo but <strong>no shipping label has been purchased yet</strong>. These orders have been waiting for over <strong>12 hours</strong>.</p>
    
    <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin: 20px 0;">
      <thead>
        <tr style="background: #fef3c7; border-bottom: 2px solid #fbbf24;">
          <th style="text-align: left; padding: 10px 12px; color: #92400e;">Order</th>
          <th style="text-align: left; padding: 10px 12px; color: #92400e;">Customer</th>
          <th style="text-align: right; padding: 10px 12px; color: #92400e;">Total</th>
          <th style="text-align: center; padding: 10px 12px; color: #92400e;">Waiting</th>
          <th style="text-align: left; padding: 10px 12px; color: #92400e;">Method</th>
        </tr>
      </thead>
      <tbody>${orderRows}</tbody>
    </table>

    <div style="text-align: center; margin: 25px 0;">
      <a href="https://apps.goshippo.com/orders" class="btn" style="background: #92400e; padding: 14px 28px;">📦 Open Shippo Dashboard</a>
    </div>

    <p style="font-size: 13px; color: #64748b;">Total revenue awaiting shipment: <strong>$${totalRevenue.toFixed(2)} CAD</strong></p>
  `;

  return sendEmail({
    to: adminEmail,
    subject: `🇨🇦 REMINDER: ${orders.length} Canada order(s) need shipping labels — $${totalRevenue.toFixed(2)} CAD`,
    html: wrapEmail('🇨🇦 Label Purchase Reminder', 'Action Required', body)
  });
}

export default {
  sendOrderConfirmationEmail,
  sendFulfillmentOrderSubmittedEmail,
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
  sendPasswordChangedEmail,
  sendNewOrderAdminAlert,
  sendNewTicketAdminAlert,
  sendPaymentFailureEmail,
  sendStaleOrderAlert,
  sendRetryExhaustedAlert,
  sendCaLabelReminderAlert
};
