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
 * ✅ GAP 3: Smart email — only fires on STATUS-level changes,
 *    not on every carrier scan (prevents email spam)
 * ✅ Non-fatal email — failed SMTP never causes a non-2xx
 *    response (Shippo would retry the webhook endlessly)
 * ✅ Always returns 200 — even on internal errors
 */

import express from "express";
import crypto from "crypto";
import db from "../config/database.js";
import { sendTrackingUpdateEmail } from "../utils/mailer.js";

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

/* ══════════════════════════════════════════════════════════ */
/* POST /api/webhooks/shippo                               */
/* ══════════════════════════════════════════════════════════ */
router.post(
  "/",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      /* ── 1. HMAC signature verification ──────────────────────── */
      const signature = req.headers["x-shippo-signature"];
      const secret = process.env.SHIPPO_WEBHOOK_SECRET;

      if (!signature) {
        console.warn("⚠️ Webhook: missing x-shippo-signature");
        return res.status(401).json({ error: "Missing signature" });
      }
      if (!secret) {
        console.error("❌ SHIPPO_WEBHOOK_SECRET is not set");
        return res.status(500).json({ error: "Webhook secret not configured" });
      }

      const expected = crypto
        .createHmac("sha256", secret)
        .update(req.body)
        .digest("hex");

      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        console.warn("⚠️ Webhook: invalid signature — possible spoofed request");
        return res.status(401).json({ error: "Invalid signature" });
      }

      /* ── 2. Parse + filter event type ────────────────────────── */
      const payload = JSON.parse(req.body.toString());

      if (payload.event !== "track_updated") {
        return res.status(200).json({ received: true, ignored: true });
      }

      const data = payload.data;
      const carrier = data?.carrier;
      const trackingNumber = data?.tracking_number;
      const newStatus = data?.tracking_status?.status || null;
      const statusDate = data?.tracking_status?.status_date || null;
      const location = data?.tracking_status?.location || null;

      if (!carrier || !trackingNumber) {
        console.warn("⚠️ Webhook: missing carrier or tracking_number");
        return res.status(200).json({ received: true, missing: true });
      }

      /* ── 3. Fetch current DB status (needed for dedup + email) ── */
      const [existing] = await db.execute(
        `SELECT
           o.id, o.shippo_tracking_status,
           u.email, u.first_name, u.last_name
         FROM orders o
         JOIN users u ON o.user_id = u.id
         WHERE o.shippo_tracking_number = ?
           AND o.shippo_carrier = ?
         LIMIT 1`,
        [trackingNumber, carrier]
      );

      if (!existing.length) {
        console.warn(`⚠️ Webhook: no order found for ${trackingNumber} / ${carrier}`);
        return res.status(200).json({ received: true, noMatch: true });
      }

      const order = existing[0];
      const oldStatus = order.shippo_tracking_status;

      /* ── 4. Idempotency — skip write if status unchanged ─────── */
      if (oldStatus === newStatus) {
        console.log(`ℹ️ Webhook: status unchanged (${newStatus}) for ${trackingNumber} — skipped`);
        return res.status(200).json({ received: true, unchanged: true });
      }

      /* ── 5. Update DB ────────────────────────────────────────── */
      await db.execute(
        `UPDATE orders
         SET shippo_tracking_status = ?,
             shippo_tracking_raw    = ?
         WHERE id = ?`,
        [newStatus, JSON.stringify(data), order.id]
      );

      console.log(
        `✅ Webhook: order #${order.id} — ${oldStatus || "null"} → ${newStatus} [${trackingNumber}]`
      );

      /* ── 6. GAP 3: Email only on status-level change ─────────── */
      if (shouldEmailCustomer(oldStatus, newStatus)) {
        try {
          await sendTrackingUpdateEmail({
            to: order.email,
            name: `${order.first_name || ""} ${order.last_name || ""}`.trim() || "Customer",
            orderNumber: order.id,
            trackingNumber,
            status: newStatus,
            statusDate,
            location,
          });
          console.log(`📧 Tracking email sent (${oldStatus} → ${newStatus}) to ${order.email}`);
        } catch (emailErr) {
          // Non-fatal: log and continue — never let email kill the webhook response
          console.error("⚠️ Tracking email failed (non-fatal):", emailErr.message);
        }
      } else {
        console.log(`ℹ️ Webhook: email skipped — same level (${oldStatus} → ${newStatus})`);
      }

      return res.status(200).json({ received: true, trackingNumber, oldStatus, newStatus });
    } catch (err) {
      console.error("❌ Shippo webhook error:", err);
      // Always 200 — Shippo must not retry due to our own internal errors
      return res.status(200).json({ received: true, error: true });
    }
  }
);

export default router;