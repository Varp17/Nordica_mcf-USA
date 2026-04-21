// import express from "express";
// import crypto from "crypto";
// import db from "../config/database.js";

// const router = express.Router();

// router.post(
//   "/",
//   express.raw({ type: "application/json" }),
//   async (req, res) => {
//     try {
//       console.log("✅ Shippo webhook hit");

//       const signature = req.headers["x-shippo-signature"];
//       const secret = process.env.SHIPPO_WEBHOOK_SECRET;

//       if (!signature) {
//         return res.status(401).json({ error: "Missing signature" });
//       }

//       const expected = crypto
//         .createHmac("sha256", secret)
//         .update(req.body)
//         .digest("hex");

//       if (signature !== expected) {
//         return res.status(401).json({ error: "Invalid signature" });
//       }

//       const payload = JSON.parse(req.body.toString());

//       if (payload.event !== "track_updated") {
//         return res.status(200).json({ ignored: true });
//       }

//       const data = payload.data;

//       await db.execute(
//         `
//         UPDATE orders
//         SET shippo_tracking_status = ?,
//             shippo_tracking_raw = ?
//         WHERE shippo_tracking_number = ?
//           AND shippo_carrier = ?
//         `,
//         [
//           data.tracking_status?.status || null,
//           JSON.stringify(data),
//           data.tracking_number,
//           data.carrier,
//         ]
//       );

//       return res.status(200).json({ received: true });
//     } catch (err) {
//       console.error("❌ Shippo webhook error:", err);
//       return res.status(500).json({ error: "Webhook failed" });
//     }
//   }
// );

// export default router;


//testing (20-3-2026)




// import express from "express";
// import crypto from "crypto";
// import db from "../config/database.js";
// import {
//   sendTrackingUpdateEmail,
// } from "../utils/mailer.js";                          // ← NEW import

// const router = express.Router();

// /* ================================================== */
// /* Shippo Webhook                                     */
// /* POST /api/webhooks/shippo                          */
// /*                                                    */
// /* Registered in your Shippo dashboard under:        */
// /*   Settings → Webhooks → track_updated             */
// /*                                                    */
// /* CHANGES FROM ORIGINAL:                            */
// /*   ✅ After DB update, fetch order + customer       */
// /*   ✅ Send tracking-status email to customer        */
// /* ================================================== */
// router.post(
//   "/",
//   express.raw({ type: "application/json" }),
//   async (req, res) => {
//     try {
//       console.log("✅ Shippo webhook received");

//       // ── HMAC signature verification ────────────────────────────────
//       const signature = req.headers["x-shippo-signature"];
//       const secret = process.env.SHIPPO_WEBHOOK_SECRET;

//       if (!signature) {
//         console.warn("⚠️ Webhook: missing x-shippo-signature header");
//         return res.status(401).json({ error: "Missing signature" });
//       }

//       if (!secret) {
//         console.error("❌ SHIPPO_WEBHOOK_SECRET env var not set");
//         return res.status(500).json({ error: "Webhook secret not configured" });
//       }

//       const expected = crypto
//         .createHmac("sha256", secret)
//         .update(req.body)
//         .digest("hex");

//       if (signature !== expected) {
//         console.warn("⚠️ Webhook: invalid signature — possible spoofed request");
//         return res.status(401).json({ error: "Invalid signature" });
//       }

//       // ── Parse payload ──────────────────────────────────────────────
//       const payload = JSON.parse(req.body.toString());

//       // Only handle tracking updates; ignore other event types
//       if (payload.event !== "track_updated") {
//         console.log(`ℹ️ Webhook: ignoring event type "${payload.event}"`);
//         return res.status(200).json({ ignored: true });
//       }

//       const data = payload.data;
//       const carrier = data?.carrier;
//       const trackingNumber = data?.tracking_number;
//       const newStatus = data?.tracking_status?.status || null;
//       const statusDate = data?.tracking_status?.status_date || null;
//       const location = data?.tracking_status?.location || null;

//       if (!carrier || !trackingNumber) {
//         console.warn("⚠️ Webhook: missing carrier or tracking_number", payload);
//         return res.status(200).json({ received: true, missing: true });
//       }

//       // ── Step 1: Update the order in DB ─────────────────────────────
//       const [updateResult] = await db.execute(
//         `UPDATE orders
//          SET shippo_tracking_status = ?,
//              shippo_tracking_raw    = ?
//          WHERE shippo_tracking_number = ?
//            AND shippo_carrier = ?`,
//         [
//           newStatus,
//           JSON.stringify(data),
//           trackingNumber,
//           carrier,
//         ]
//       );

//       if (!updateResult.affectedRows) {
//         // No matching order found — could be a test event or stale data
//         console.warn(
//           `⚠️ Webhook: no order found for tracking ${trackingNumber} / ${carrier}`
//         );
//         return res.status(200).json({ received: true, noMatch: true });
//       }

//       console.log(
//         `✅ Webhook: updated tracking status to "${newStatus}" for ${trackingNumber}`
//       );

//       // ──────────────────────────────────────────────────────────────
//       // ✅ CHANGE: Fetch order + customer, then send tracking email
//       // Non-fatal — email failure must NOT affect the 200 response
//       // (Shippo retries webhooks on non-2xx responses).
//       // ──────────────────────────────────────────────────────────────
//       try {
//         const [orderRows] = await db.execute(
//           `SELECT
//              o.id,
//              o.shippo_tracking_number,
//              u.email,
//              u.first_name,
//              u.last_name
//            FROM orders o
//            JOIN users u ON o.user_id = u.id
//            WHERE o.shippo_tracking_number = ?
//              AND o.shippo_carrier = ?
//            LIMIT 1`,
//           [trackingNumber, carrier]
//         );

//         if (orderRows.length) {
//           const ord = orderRows[0];

//           await sendTrackingUpdateEmail({
//             to: ord.email,
//             name:
//               `${ord.first_name || ""} ${ord.last_name || ""}`.trim() ||
//               "Customer",
//             orderNumber: ord.id,
//             trackingNumber: ord.shippo_tracking_number,
//             status: newStatus,
//             statusDate,
//             location,
//           });
//         } else {
//           console.warn(
//             `⚠️ Email skipped: could not find order+user for tracking ${trackingNumber}`
//           );
//         }
//       } catch (emailErr) {
//         console.error(
//           "⚠️ Tracking update email failed (non-fatal):",
//           emailErr.message
//         );
//       }

//       return res.status(200).json({ received: true, trackingNumber, carrier });
//     } catch (err) {
//       console.error("❌ Shippo webhook error:", err);
//       // Always return 200 to prevent Shippo from retrying on our own errors
//       return res.status(200).json({ received: true, error: true });
//     }
//   }
// );

// export default router;



//testing 2
/**
 * routes/shippoWebhook.js
 * Mounted at: /api/webhooks/shippo
 *
 * Receives track_updated events from Shippo.
 *
 * Production features
 * ────────────────────────────────────────────────────────────
 * ✅ HMAC signature verification (rejects spoofed requests)
 * ✅ Idempotency — skips DB write if status hasn't changed
 * ✅ Smart email — only fires on STATUS-LEVEL changes
 * ✅ Non-fatal email — failed SMTP never causes a non-2xx response
 * ✅ Always returns 200 — even on internal errors
 */

import express from "express";
import crypto from "crypto";
import db from "../config/database.js";
import { sendTrackingUpdateEmail } from "../utils/mailer.js";
import { sendOrderShippedEmail } from "../services/emailService.js";
import logger from "../utils/logger.js";

const router = express.Router();

/* ─────────────────────────────────────────────────── */
/* Status hierarchy                                    */
/*                                                     */
/* Shippo fires track_updated on every carrier scan.   */
/* A package can be scanned 6-10 times in one day,     */
/* all with status = "TRANSIT".                        */
/*                                                     */
/* We email the customer only when the STATUS-LEVEL    */
/* changes (e.g. PRE_TRANSIT → TRANSIT), not on every  */
/* scan within the same status.                        */
/* ─────────────────────────────────────────────────── */
const STATUS_LEVELS = {
  UNKNOWN: 0,
  PRE_TRANSIT: 1,
  TRANSIT: 2,
  DELIVERED: 3,
  RETURNED: 4,
  FAILURE: 4,
};

/**
 * Returns true only when newStatus represents a meaningful
 * step the customer should be told about.
 */
const shouldEmailCustomer = (oldStatus, newStatus) => {
  if (!newStatus) return false;
  if (!oldStatus || oldStatus === "UNKNOWN") return newStatus !== "UNKNOWN";

  const oldLevel = STATUS_LEVELS[oldStatus?.toUpperCase()] ?? -1;
  const newLevel = STATUS_LEVELS[newStatus?.toUpperCase()] ?? -1;

  // Always email on DELIVERED and FAILURE regardless of level jump
  if (["DELIVERED", "FAILURE", "RETURNED"].includes(newStatus?.toUpperCase())) return true;

  // Email when the level actually increases
  return newLevel > oldLevel;
};

/**
 * POST /api/webhooks/shippo
 */
router.post(
  "/",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      /* ── 1. HMAC signature verification ──────────────────────── */
      const signature = req.headers["x-shippo-signature"];
      const secret = process.env.SHIPPO_WEBHOOK_SECRET;

      if (!signature) {
        logger.warn("Shippo Webhook: Missing signature");
        return res.status(401).json({ error: "Missing signature" });
      }
      if (!secret) {
        logger.error("Shippo Webhook: Secret not configured");
        return res.status(500).json({ error: "Webhook secret not configured" });
      }

      // EDGE CASE #68: timingSafeEqual requires buffers of identical length
      const expected = crypto
        .createHmac("sha256", secret)
        .update(req.body)
        .digest("hex");

      const sigBuffer = Buffer.from(signature);
      const expectedBuffer = Buffer.from(expected);

      if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
        logger.warn("Shippo Webhook: Invalid signature");
        return res.status(401).json({ error: "Invalid signature" });
      }

      /* ── 2. Parse payload ────────────────────────── */
      const payload = JSON.parse(req.body.toString());

      if (!["track_updated", "transaction_created", "transaction_updated"].includes(payload.event)) {
        return res.status(200).json({ received: true, ignored: true });
      }

      const data = payload.data;

      /* ── TRANSACTION EVENTS (Label Purchased in Dashboard) ── */
      if (payload.event.startsWith("transaction_")) {
        const shippoOrderId = data.order;
        const trackingNumber = data.tracking_number;
        
        if (!shippoOrderId || !trackingNumber) {
          return res.status(200).json({ received: true, missing_data: true });
        }

        // Find the order that matches this Shippo Order ID
        const [orders] = await db.execute(
          `SELECT o.*, u.email as user_email, u.first_name, u.last_name 
           FROM orders o
           LEFT JOIN users u ON o.user_id = u.id
           WHERE o.shippo_order_id = ?
           LIMIT 1`,
          [shippoOrderId]
        );

        if (!orders.length) {
          logger.warn(`Shippo Webhook: No order found for Shippo Order ID ${shippoOrderId}`);
          return res.status(200).json({ received: true, noMatch: true });
        }

        const order = orders[0];
        
        // Avoid redundant updates
        if (order.shippo_tracking_number === trackingNumber) {
          return res.status(200).json({ received: true, unchanged: true });
        }

        // Extract carrier (some transactions have tracking_status.provider or we default to 'shippo')
        // Actually, Shippo transaction object does not explicitly give the carrier at root sometimes, but tracking_url_provider might hint.
        // Or if we know it's Canada Post, we can leave it. We'll set a default and let track_updated fix it later.
        const carrier = data.tracking_status?.provider || 'Shippo Carrier';
        const labelUrl = data.label_url;
        
        // We know the label was just purchased, so it's pre-transit and shipped!
        await db.execute(
          `UPDATE orders
           SET shippo_tracking_number = ?,
               shippo_carrier = ?,
               shippo_tracking_status = 'PRE_TRANSIT',
               shippo_label_url = ?,
               fulfillment_status = 'shipped',
               updated_at = NOW()
           WHERE id = ?`,
          [trackingNumber, carrier, labelUrl || null, order.id]
        );

        logger.info(`Shippo Webhook: Label created for #${order.id}. Tracking: ${trackingNumber}`);

        // Send Order Shipped Email!
        const recipientEmail = order.user_email || order.customer_email;
        if (recipientEmail) {
          try {
            // We need to shape the order object as expected by sendOrderShippedEmail
            const trackingData = {
              trackingNumber: trackingNumber,
              carrier: carrier,
              trackingUrl: data.tracking_url_provider || `https://goshippo.com/tracking?number=${trackingNumber}`
            };
            await sendOrderShippedEmail({ ...order, customer_email: recipientEmail }, trackingData);
            logger.info(`Shippo Webhook: Shipped email sent to ${recipientEmail} for #${order.id}`);
          } catch (e) {
            logger.error("Shippo Webhook: Failed to send shipped email", { error: e.message });
          }
        }

        return res.status(200).json({ received: true, updated: true, trackingNumber });
      }

      /* ── TRACK_UPDATED EVENT ── */
      const carrier = data?.carrier;
      const trackingNumber = data?.tracking_number;
      const newStatus = data?.tracking_status?.status || null;
      const statusDate = data?.tracking_status?.status_date || null;
      const location = data?.tracking_status?.location || null;

      if (!carrier || !trackingNumber) {
        return res.status(200).json({ received: true, missing: true });
      }

      /* ── 3. Fetch current DB status ── */
      // EDGE CASE #69: Use LEFT JOIN to support guest orders (no user_id)
      const [existing] = await db.execute(
        `SELECT
           o.id, o.shippo_tracking_status, o.customer_email,
           u.email as user_email, u.first_name, u.last_name
         FROM orders o
         LEFT JOIN users u ON o.user_id = u.id
         WHERE o.shippo_tracking_number = ?
           AND o.shippo_carrier = ?
         LIMIT 1`,
        [trackingNumber, carrier]
      );

      if (!existing.length) {
        logger.warn(`Shippo Webhook: No order found for ${trackingNumber}`);
        return res.status(200).json({ received: true, noMatch: true });
      }

      const order = existing[0];
      const oldStatus = order.shippo_tracking_status;
      const recipientEmail = order.user_email || order.customer_email;

      /* ── 4. Idempotency ─────── */
      if (oldStatus === newStatus) {
        return res.status(200).json({ received: true, unchanged: true });
      }

      /* ── 5. Update DB ────────────────────────────────────────── */
      await db.execute(
        `UPDATE orders
         SET shippo_tracking_status = ?,
             shippo_tracking_raw    = ?,
             updated_at             = NOW()
         WHERE id = ?`,
        [newStatus, JSON.stringify(data), order.id]
      );

      /* ── 6. Email only on status-level change ─────────── */
      if (shouldEmailCustomer(oldStatus, newStatus) && recipientEmail) {
        try {
          await sendTrackingUpdateEmail({
            to: recipientEmail,
            name: `${order.first_name || ""} ${order.last_name || ""}`.trim() || "Valued Customer",
            orderNumber: order.id,
            trackingNumber,
            status: newStatus,
            statusDate,
            location,
          });
          logger.info(`Shippo Webhook: Tracking email sent to ${recipientEmail} for #${order.id}`);
        } catch (emailErr) {
          logger.error("Shippo Webhook Email Failure (Non-fatal)", { error: emailErr.message });
        }
      }

      return res.status(200).json({ received: true, trackingNumber, carrier, newStatus });
    } catch (err) {
      logger.error(`Shippo Webhook Processing Error: ${err.message}`);
      return res.status(200).json({ received: true, error: true });
    }
  }
);

export default router;