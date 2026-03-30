/**
 * utils/mailer.js
 *
 * Centralised email utility for the Shippo Canada order workflow.
 *
 * Exports
 * ────────────────────────────────────────────────────
 * sendShipmentCreatedEmail()   → fires once when admin buys label
 * sendTrackingUpdateEmail()    → fires on each status-level change
 *
 * Configuration (via .env)
 * ────────────────────────────────────────────────────
 * SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS
 * SMTP_FROM     → the "from" address shown to the customer
 * STORE_NAME    → displayed in email header + subject
 */

import nodemailer from "nodemailer";

/* ─────────────────────────────────────────────────── */
/* Transporter                                         */
/* ─────────────────────────────────────────────────── */
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || "smtp.gmail.com",
  port:   Number(process.env.SMTP_PORT) || 465, // Prefer 465 for SSL or 587 for TLS
  secure: (Number(process.env.SMTP_PORT) === 465), 
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  // Reliability settings
  connectionTimeout: 20000,
  greetingTimeout: 10000,
  socketTimeout: 30000,
  family: 4, // Force IPv4 to prevent ENETUNREACH address resolving
  tls: {
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2'
  }
});

/* ─────────────────────────────────────────────────── */
/* HTML email wrapper                                  */
/* ─────────────────────────────────────────────────── */
const storeName = () => process.env.STORE_NAME || "Detail Guardz";

const emailWrapper = (bodyHtml) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <style>
    body{font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:0}
    .wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)}
    .hdr{background:#1a1a2e;padding:24px 32px}
    .hdr h1{color:#fff;margin:0;font-size:20px;font-weight:600}
    .body{padding:32px;color:#333;line-height:1.7;font-size:15px}
    .body p{margin:0 0 16px}
    .info{background:#f8f9ff;border-left:4px solid #4a6cf7;border-radius:4px;padding:16px 20px;margin:20px 0}
    .info p{margin:4px 0;font-size:14px}
    .info strong{color:#1a1a2e}
    .badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:13px;font-weight:600}
    .badge-green{background:#e8f5e9;color:#2e7d32}
    .badge-blue{background:#e3f2fd;color:#1565c0}
    .badge-red{background:#ffebee;color:#c62828}
    .badge-amber{background:#fff8e1;color:#f57f17}
    .btn{display:inline-block;background:#4a6cf7;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;font-size:14px;margin-top:8px}
    .ftr{background:#f8f8f8;padding:16px 32px;text-align:center;font-size:12px;color:#999}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hdr"><h1>${storeName()}</h1></div>
    <div class="body">${bodyHtml}</div>
    <div class="ftr">&copy; ${new Date().getFullYear()} ${storeName()}. All rights reserved.</div>
  </div>
</body>
</html>`;

/* ─────────────────────────────────────────────────── */
/* Status config                                       */
/* ─────────────────────────────────────────────────── */
const STATUS_CONFIG = {
  UNKNOWN:     { label: "Processing",    badgeClass: "badge-blue",  subject: (n) => `Order #${n} is being processed` },
  PRE_TRANSIT: { label: "Pre-Transit",   badgeClass: "badge-blue",  subject: (n) => `Order #${n} is ready to ship 📦` },
  TRANSIT:     { label: "In Transit",    badgeClass: "badge-blue",  subject: (n) => `Your order #${n} is on its way 🚚` },
  DELIVERED:   { label: "Delivered",     badgeClass: "badge-green", subject: (n) => `Your order #${n} has been delivered! ✅` },
  RETURNED:    { label: "Returned",      badgeClass: "badge-amber", subject: (n) => `Your order #${n} is being returned` },
  FAILURE:     { label: "Delivery Issue",badgeClass: "badge-red",   subject: (n) => `Action needed for order #${n} ⚠️` },
};

const getStatusConfig = (status) =>
  STATUS_CONFIG[status?.toUpperCase()] || {
    label: status || "Update", badgeClass: "badge-blue",
    subject: (n) => `Shipping update for order #${n}`,
  };

/* ══════════════════════════════════════════════════════════ */
/* 1. Shipment created                                      */
/*    Fired once when the admin buys a label in the CRM.    */
/* ══════════════════════════════════════════════════════════ */
/**
 * @param {object}      opts
 * @param {string}      opts.to             Customer email address
 * @param {string}      opts.name           Customer full name
 * @param {string|number} opts.orderNumber  Order ID
 * @param {string}      opts.trackingNumber
 * @param {string}      opts.carrier        e.g. "canada_post"
 * @param {string|null} opts.labelUrl       Shippo PDF label URL
 */
export async function sendShipmentCreatedEmail({
  to, name, orderNumber, trackingNumber, carrier, labelUrl,
}) {
  const body = `
    <p>Hi ${name},</p>
    <p>Great news — your order <strong>#${orderNumber}</strong> has been shipped and is on its way!</p>
    <div class="info">
      <p><strong>Carrier:</strong> ${carrier}</p>
      <p><strong>Tracking Number:</strong> ${trackingNumber}</p>
    </div>
    <p>Use your tracking number on the carrier's website to follow your shipment in real time.</p>
    ${labelUrl ? `<p><a class="btn" href="${labelUrl}" target="_blank">View Shipping Label</a></p>` : ""}
    <p>Thank you for shopping with us!</p>`;

  await transporter.sendMail({
    from:    `"${storeName()}" <${process.env.SMTP_FROM}>`,
    to,
    subject: `Your order #${orderNumber} has shipped! 🚚`,
    html:    emailWrapper(body),
  });

  console.log(`📧 Shipment created email → ${to} (order #${orderNumber})`);
}

/* ══════════════════════════════════════════════════════════ */
/* 2. Tracking status update                                */
/*    Fired by the webhook on each status-level change.     */
/*    Subject line and body copy adapt per status.          */
/* ══════════════════════════════════════════════════════════ */
/**
 * @param {object}      opts
 * @param {string}      opts.to
 * @param {string}      opts.name
 * @param {string|number} opts.orderNumber
 * @param {string}      opts.trackingNumber
 * @param {string}      opts.status          e.g. "TRANSIT", "DELIVERED"
 * @param {string|null} opts.statusDate      ISO date string
 * @param {object|null} opts.location        { city, state, country }
 */
export async function sendTrackingUpdateEmail({
  to, name, orderNumber, trackingNumber, status, statusDate, location,
}) {
  const cfg          = getStatusConfig(status);
  const locationStr  = location?.city
    ? [location.city, location.state, location.country].filter(Boolean).join(", ")
    : null;

  const statusMessage = {
    DELIVERED: `<p>Your order has arrived — we hope you enjoy your purchase! 🎉</p>`,
    FAILURE:   `<p>There was an issue delivering your order. Please contact us or your carrier directly for next steps.</p>`,
    RETURNED:  `<p>Your order is on its way back to us. Our team will be in touch shortly.</p>`,
  }[status?.toUpperCase()] || `<p>Your order is on its way. We'll notify you when there are further updates.</p>`;

  const body = `
    <p>Hi ${name},</p>
    <p>Here is the latest update for your order <strong>#${orderNumber}</strong>:</p>
    <div class="info">
      <p><strong>Status:</strong> <span class="badge ${cfg.badgeClass}">${cfg.label}</span></p>
      <p><strong>Tracking Number:</strong> ${trackingNumber}</p>
      ${statusDate  ? `<p><strong>Updated:</strong> ${new Date(statusDate).toLocaleString("en-CA", { dateStyle: "long", timeStyle: "short" })}</p>` : ""}
      ${locationStr ? `<p><strong>Location:</strong> ${locationStr}</p>` : ""}
    </div>
    ${statusMessage}
    <p>Thank you for shopping with us!</p>`;

  await transporter.sendMail({
    from:    `"${storeName()}" <${process.env.SMTP_FROM}>`,
    to,
    subject: cfg.subject(orderNumber),
    html:    emailWrapper(body),
  });

  console.log(`📧 Tracking update email (${status}) → ${to} (order #${orderNumber})`);
}