// import express from "express";
// import { Shippo } from "shippo";
// import db from "../config/database.js";
// import { authenticateToken, requireAdmin } from "../middleware/auth.js";

// const router = express.Router();

// /* -------------------------------------------------- */
// /* Shippo Client                                      */
// /* -------------------------------------------------- */
// const shippo = new Shippo({
//   apiKeyHeader: process.env.SHIPPO_API_TOKEN,
//   shippoApiVersion: "2018-02-08",
// });

// /* -------------------------------------------------- */
// /* Helpers                                            */
// /* -------------------------------------------------- */
// const mapShippoTracking = (tracking) => ({
//   status: tracking?.tracking_status?.status || null,
//   substatus: tracking?.tracking_status?.substatus || null,
//   statusDate: tracking?.tracking_status?.status_date || null,
//   location: tracking?.tracking_status?.location || null,
//   carrier: tracking?.carrier || null,
//   trackingNumber: tracking?.tracking_number || null,
//   serviceLevel: tracking?.servicelevel?.name || null,
//   eta: tracking?.eta || null,
//   history: tracking?.tracking_history || [],
// });

// /* ================================================== */
// /* 0️⃣ Export shippo client for other routes          */
// /* ================================================== */
// export const shippoClient = shippo;

// /* ================================================== */
// /* 1️⃣ Orders from Shippo (no local DB)               */
// /* GET /api/admin/shippo/orders                       */
// /* ================================================== */
// router.get(
//   "/orders",
//   authenticateToken,
//   requireAdmin,
//   async (req, res) => {
//     try {
//       console.log("📦 GET /orders (Shippo Orders API)");

//       const { page = 1 } = req.query;

//       const orders = await shippo.orders.list({
//         page: Number(page),
//         results: 50,
//       });

//       const mapped = (orders.results || []).map((o) => {
//         return {
//           orderId: o.object_id,
//           orderNumber: o.order_number || null,
//           toName: o.to_address?.name || null,
//           toCity: o.to_address?.city || null,
//           toState: o.to_address?.state || null,
//           toCountry: o.to_address?.country || null,
//           totalPrice: o.total_price || null,
//           currency: o.currency || null,
//           status: o.order_status || null,
//           createdAt: o.object_created || null,
//           raw: o,
//         };
//       });

//       res.json({
//         success: true,
//         data: mapped,
//         pagination: {
//           page: orders.page || Number(page),
//           next: orders.next,
//           previous: orders.previous,
//         },
//       });
//     } catch (err) {
//       console.error("❌ List Shippo orders error:", err);
//       res.status(500).json({ error: "Failed to list Shippo orders" });
//     }
//   }
// );

// /* ================================================== */
// /* 2️⃣ Transactions (labels) from Shippo              */
// /* GET /api/admin/shippo/transactions                 */
// /* ================================================== */
// router.get(
//   "/transactions",
//   authenticateToken,
//   requireAdmin,
//   async (req, res) => {
//     try {
//       console.log("🏷️ GET /transactions (Shippo Transactions API)");

//       const { page = 1 } = req.query;

//       const transactions = await shippo.transactions.list({
//         page: Number(page),
//         results: 50,
//       });

//       const mapped = (transactions.results || []).map((t) => {
//         const trackingNumber =
//           t.tracking_number || t.trackingNumber || null;
//         const carrier =
//           t.tracking_carrier ||
//           t.trackingCarrier ||
//           t.carrier ||
//           null;
//         const trackingStatus =
//           t.tracking_status || t.trackingStatus || null;

//         return {
//           transactionId: t.object_id,
//           orderId: t.order || null,
//           trackingNumber,
//           carrier,
//           trackingStatus,
//           labelUrl: t.label_url || t.labelUrl || null,
//           serviceLevel:
//             t.servicelevel_name || t.servicelevelName || null,
//           price: t.rate || null,
//           currency: t.currency || null,
//           createdAt: t.object_created || null,
//           raw: t,
//         };
//       });

//       res.json({
//         success: true,
//         data: mapped,
//         pagination: {
//           page: transactions.page || Number(page),
//           next: transactions.next,
//           previous: transactions.previous,
//         },
//       });
//     } catch (err) {
//       console.error("❌ List Shippo transactions error:", err);
//       res
//         .status(500)
//         .json({ error: "Failed to list Shippo transactions" });
//     }
//   }
// );

// /* ================================================== */
// /* 3️⃣ Trackings (detailed) from Shippo               */
// /* GET /api/admin/shippo/trackings                    */
// /* ================================================== */
// router.get(
//   "/trackings",
//   authenticateToken,
//   requireAdmin,
//   async (req, res) => {
//     try {
//       console.log("📊 GET /trackings (Shippo trackingStatus API)");

//       const { status, page = 1 } = req.query;

//       const transactions = await shippo.transactions.list({
//         page: Number(page),
//         results: 20,
//       });

//       const results = transactions.results || [];

//       const detailed = await Promise.all(
//         results.map(async (t) => {
//           const trackingNumber =
//             t.tracking_number || t.trackingNumber || null;
//           const carrier =
//             t.tracking_carrier ||
//             t.trackingCarrier ||
//             t.carrier ||
//             null;

//           let tracking = null;
//           if (trackingNumber && carrier) {
//             try {
//               const ts = await shippo.trackingStatus.get(
//                 carrier,
//                 trackingNumber
//               );
//               tracking = mapShippoTracking(ts);
//             } catch (err) {
//               console.error(
//                 "⚠️ trackingStatus.get failed for",
//                 carrier,
//                 trackingNumber,
//                 err
//               );
//             }
//           }

//           const trackingStatus =
//             tracking?.status ||
//             t.tracking_status ||
//             t.trackingStatus ||
//             null;

//           return {
//             transactionId: t.object_id,
//             orderId: t.order || null,
//             shippo_tracking_number: trackingNumber,
//             shippo_carrier: carrier,
//             shippo_tracking_status: trackingStatus,
//             tracking,
//             tracking_raw: tracking || t,
//           };
//         })
//       );

//       const filtered = status
//         ? detailed.filter(
//             (d) =>
//               (d.shippo_tracking_status || "").toUpperCase() ===
//               String(status).toUpperCase()
//           )
//         : detailed;

//       res.json({
//         success: true,
//         data: filtered,
//         pagination: {
//           page: transactions.page || Number(page),
//           next: transactions.next,
//           previous: transactions.previous,
//         },
//       });
//     } catch (err) {
//       console.error("❌ List Shippo trackings error:", err);
//       res
//         .status(500)
//         .json({ error: "Failed to list Shippo trackings" });
//     }
//   }
// );

// /* ================================================== */
// /* 4️⃣ Save tracking info to local order              */
// /* ================================================== */
// router.put(
//   "/orders/:id/tracking",
//   authenticateToken,
//   requireAdmin,
//   async (req, res) => {
//     try {
//       const tracking_number = req.body.tracking_number;
//       const carrier = req.body.carrier || process.env.DEFAULT_SHIPPO_CARRIER;

//       if (!tracking_number || !carrier) {
//         return res.status(400).json({
//           error: "tracking_number and carrier are required",
//         });
//       }

//       const [result] = await db.execute(
//         `
//         UPDATE orders
//         SET shippo_tracking_number = ?,
//             shippo_carrier = ?,
//             shippo_tracking_status = 'UNKNOWN'
//         WHERE id = ?
//         `,
//         [tracking_number, carrier, req.params.id]
//       );

//       if (!result.affectedRows) {
//         return res.status(404).json({ error: "Order not found" });
//       }

//       res.json({ success: true, message: "Shippo tracking saved" });
//     } catch (err) {
//       console.error("Save Shippo error:", err);
//       res.status(500).json({ error: "Failed to save Shippo data" });
//     }
//   }
// );

// router.get(
//   "/orders/:id/track",
//   authenticateToken,
//   requireAdmin,
//   async (req, res) => {
//     try {
//       const [rows] = await db.execute(
//         `
//         SELECT shippo_tracking_number, shippo_carrier
//         FROM orders
//         WHERE id = ?
//         `,
//         [req.params.id]
//       );

//       if (!rows.length) {
//         return res.status(404).json({ error: "Order not found" });
//       }

//       const order = rows[0];

//       if (!order.shippo_tracking_number || !order.shippo_carrier) {
//         return res.status(400).json({
//           error: "Order has no Shippo tracking info",
//         });
//       }

//       const tracking = await shippo.trackingStatus.get(
//         order.shippo_carrier,
//         order.shippo_tracking_number
//       );

//       const mapped = mapShippoTracking(tracking);

//       await db.execute(
//         `
//         UPDATE orders
//         SET shippo_tracking_status = ?,
//             shippo_tracking_raw = ?
//         WHERE id = ?
//         `,
//         [mapped.status, JSON.stringify(tracking), req.params.id]
//       );

//       res.json({ success: true, data: mapped });
//     } catch (err) {
//       console.error("Manual tracking error:", err);
//       res.status(500).json({ error: "Tracking failed" });
//     }
//   }
// );

// /* ================================================== */
// /* 5️⃣ Shippo webhook listener                        */
// /* POST /api/admin/shippo/webhook                    */
// /* ================================================== */
// router.post("/webhook", express.json(), async (req, res) => {
//   try {
//     console.log("✅ Shippo webhook hit");

//     const payload = req.body;

//     const event = payload?.event || payload?.type || null;
//     const tracking = payload?.data || payload;

//     if (event && event !== "track_updated") {
//       return res.status(200).json({ received: true, ignored: true });
//     }

//     const carrier = tracking?.carrier;
//     const trackingNumber = tracking?.tracking_number;

//     if (!carrier || !trackingNumber) {
//       console.warn("Webhook missing carrier/tracking_number", payload);
//       return res.status(200).json({ received: true, missing: true });
//     }

//     const mapped = mapShippoTracking(tracking);

//     await db.execute(
//       `
//       UPDATE orders
//       SET shippo_tracking_status = ?,
//           shippo_tracking_raw = ?
//       WHERE shippo_tracking_number = ?
//         AND shippo_carrier = ?
//       `,
//       [mapped.status, JSON.stringify(tracking), trackingNumber, carrier]
//     );

//     console.log(`✅ Webhook updated tracking: ${trackingNumber}`);

//     res.status(200).json({ received: true, trackingNumber, carrier });
//   } catch (err) {
//     console.error("❌ Shippo webhook error:", err);
//     res.status(200).json({ received: true, error: true });
//   }
// });

// export default router;


//testing (20-3-2026)


// import express from "express";
// import { Shippo } from "shippo";
// import db from "../config/database.js";
// import { authenticateToken, requireAdmin } from "../middleware/auth.js";
// import {
//   sendShipmentCreatedEmail,
//   sendTrackingUpdateEmail,
// } from "../utils/mailer.js";                          // ← NEW import

// const router = express.Router();

// /* -------------------------------------------------- */
// /* Shippo Client                                      */
// /* -------------------------------------------------- */
// const shippo = new Shippo({
//   apiKeyHeader: process.env.SHIPPO_API_TOKEN,
//   shippoApiVersion: "2018-02-08",
// });

// /* -------------------------------------------------- */
// /* Helpers                                            */
// /* -------------------------------------------------- */
// const mapShippoTracking = (tracking) => ({
//   status: tracking?.tracking_status?.status || null,
//   substatus: tracking?.tracking_status?.substatus || null,
//   statusDate: tracking?.tracking_status?.status_date || null,
//   location: tracking?.tracking_status?.location || null,
//   carrier: tracking?.carrier || null,
//   trackingNumber: tracking?.tracking_number || null,
//   serviceLevel: tracking?.servicelevel?.name || null,
//   eta: tracking?.eta || null,
//   history: tracking?.tracking_history || [],
// });

// /* ================================================== */
// /* 0️⃣ Export shippo client for other routes          */
// /* ================================================== */
// export const shippoClient = shippo;

// /* ================================================== */
// /* 1️⃣ Orders from Shippo (no local DB)               */
// /* GET /api/admin/shippo/orders                       */
// /* ================================================== */
// router.get(
//   "/orders",
//   authenticateToken,
//   requireAdmin,
//   async (req, res) => {
//     try {
//       console.log("📦 GET /orders (Shippo Orders API)");

//       const { page = 1 } = req.query;

//       const orders = await shippo.orders.list({
//         page: Number(page),
//         results: 50,
//       });

//       const mapped = (orders.results || []).map((o) => ({
//         orderId: o.object_id,
//         orderNumber: o.order_number || null,
//         toName: o.to_address?.name || null,
//         toCity: o.to_address?.city || null,
//         toState: o.to_address?.state || null,
//         toCountry: o.to_address?.country || null,
//         totalPrice: o.total_price || null,
//         currency: o.currency || null,
//         status: o.order_status || null,
//         createdAt: o.object_created || null,
//         raw: o,
//       }));

//       res.json({
//         success: true,
//         data: mapped,
//         pagination: {
//           page: orders.page || Number(page),
//           next: orders.next,
//           previous: orders.previous,
//         },
//       });
//     } catch (err) {
//       console.error("❌ List Shippo orders error:", err);
//       res.status(500).json({ error: "Failed to list Shippo orders" });
//     }
//   }
// );

// /* ================================================== */
// /* 2️⃣ Transactions (labels) from Shippo              */
// /* GET /api/admin/shippo/transactions                 */
// /* ================================================== */
// router.get(
//   "/transactions",
//   authenticateToken,
//   requireAdmin,
//   async (req, res) => {
//     try {
//       console.log("🏷️ GET /transactions (Shippo Transactions API)");

//       const { page = 1 } = req.query;

//       const transactions = await shippo.transactions.list({
//         page: Number(page),
//         results: 50,
//       });

//       const mapped = (transactions.results || []).map((t) => {
//         const trackingNumber = t.tracking_number || t.trackingNumber || null;
//         const carrier =
//           t.tracking_carrier || t.trackingCarrier || t.carrier || null;
//         const trackingStatus = t.tracking_status || t.trackingStatus || null;

//         return {
//           transactionId: t.object_id,
//           orderId: t.order || null,
//           trackingNumber,
//           carrier,
//           trackingStatus,
//           labelUrl: t.label_url || t.labelUrl || null,
//           serviceLevel: t.servicelevel_name || t.servicelevelName || null,
//           price: t.rate || null,
//           currency: t.currency || null,
//           createdAt: t.object_created || null,
//           raw: t,
//         };
//       });

//       res.json({
//         success: true,
//         data: mapped,
//         pagination: {
//           page: transactions.page || Number(page),
//           next: transactions.next,
//           previous: transactions.previous,
//         },
//       });
//     } catch (err) {
//       console.error("❌ List Shippo transactions error:", err);
//       res.status(500).json({ error: "Failed to list Shippo transactions" });
//     }
//   }
// );

// /* ================================================== */
// /* 3️⃣ Trackings (detailed) from Shippo               */
// /* GET /api/admin/shippo/trackings                    */
// /* ================================================== */
// router.get(
//   "/trackings",
//   authenticateToken,
//   requireAdmin,
//   async (req, res) => {
//     try {
//       console.log("📊 GET /trackings (Shippo trackingStatus API)");

//       const { status, page = 1 } = req.query;

//       const transactions = await shippo.transactions.list({
//         page: Number(page),
//         results: 20,
//       });

//       const results = transactions.results || [];

//       const detailed = await Promise.all(
//         results.map(async (t) => {
//           const trackingNumber = t.tracking_number || t.trackingNumber || null;
//           const carrier =
//             t.tracking_carrier || t.trackingCarrier || t.carrier || null;

//           let tracking = null;
//           if (trackingNumber && carrier) {
//             try {
//               const ts = await shippo.trackingStatus.get(carrier, trackingNumber);
//               tracking = mapShippoTracking(ts);
//             } catch (err) {
//               console.error(
//                 "⚠️ trackingStatus.get failed for",
//                 carrier,
//                 trackingNumber,
//                 err
//               );
//             }
//           }

//           const trackingStatus =
//             tracking?.status || t.tracking_status || t.trackingStatus || null;

//           return {
//             transactionId: t.object_id,
//             orderId: t.order || null,
//             shippo_tracking_number: trackingNumber,
//             shippo_carrier: carrier,
//             shippo_tracking_status: trackingStatus,
//             tracking,
//             tracking_raw: tracking || t,
//           };
//         })
//       );

//       const filtered = status
//         ? detailed.filter(
//             (d) =>
//               (d.shippo_tracking_status || "").toUpperCase() ===
//               String(status).toUpperCase()
//           )
//         : detailed;

//       res.json({
//         success: true,
//         data: filtered,
//         pagination: {
//           page: transactions.page || Number(page),
//           next: transactions.next,
//           previous: transactions.previous,
//         },
//       });
//     } catch (err) {
//       console.error("❌ List Shippo trackings error:", err);
//       res.status(500).json({ error: "Failed to list Shippo trackings" });
//     }
//   }
// );

// /* ================================================== */
// /* 4️⃣ Save tracking info to local order              */
// /* PUT /api/admin/shippo/orders/:id/tracking          */
// /* ================================================== */
// router.put(
//   "/orders/:id/tracking",
//   authenticateToken,
//   requireAdmin,
//   async (req, res) => {
//     try {
//       const tracking_number = req.body.tracking_number;
//       const carrier =
//         req.body.carrier || process.env.DEFAULT_SHIPPO_CARRIER;

//       if (!tracking_number || !carrier) {
//         return res
//           .status(400)
//           .json({ error: "tracking_number and carrier are required" });
//       }

//       const [result] = await db.execute(
//         `UPDATE orders
//          SET shippo_tracking_number = ?,
//              shippo_carrier = ?,
//              shippo_tracking_status = 'UNKNOWN'
//          WHERE id = ?`,
//         [tracking_number, carrier, req.params.id]
//       );

//       if (!result.affectedRows) {
//         return res.status(404).json({ error: "Order not found" });
//       }

//       res.json({ success: true, message: "Shippo tracking saved" });
//     } catch (err) {
//       console.error("Save Shippo error:", err);
//       res.status(500).json({ error: "Failed to save Shippo data" });
//     }
//   }
// );

// /* ================================================== */
// /* 5️⃣ Manual: fetch live tracking for one order      */
// /* GET /api/admin/shippo/orders/:id/track             */
// /* ================================================== */
// router.get(
//   "/orders/:id/track",
//   authenticateToken,
//   requireAdmin,
//   async (req, res) => {
//     try {
//       const [rows] = await db.execute(
//         `SELECT shippo_tracking_number, shippo_carrier
//          FROM orders WHERE id = ?`,
//         [req.params.id]
//       );

//       if (!rows.length) {
//         return res.status(404).json({ error: "Order not found" });
//       }

//       const order = rows[0];

//       if (!order.shippo_tracking_number || !order.shippo_carrier) {
//         return res
//           .status(400)
//           .json({ error: "Order has no Shippo tracking info" });
//       }

//       const tracking = await shippo.trackingStatus.get(
//         order.shippo_carrier,
//         order.shippo_tracking_number
//       );

//       const mapped = mapShippoTracking(tracking);

//       await db.execute(
//         `UPDATE orders
//          SET shippo_tracking_status = ?,
//              shippo_tracking_raw = ?
//          WHERE id = ?`,
//         [mapped.status, JSON.stringify(tracking), req.params.id]
//       );

//       res.json({ success: true, data: mapped });
//     } catch (err) {
//       console.error("Manual tracking error:", err);
//       res.status(500).json({ error: "Tracking failed" });
//     }
//   }
// );

// /* ================================================== */
// /* 6️⃣ Create Shippo shipment + buy label             */
// /* POST /api/admin/shippo/orders/:id/shippo-create    */
// /*                                                    */
// /* CHANGES FROM ORIGINAL:                             */
// /*   ✅ Saves shippo_label_url to the DB              */
// /*   ✅ Sends shipment-created email to customer      */
// /* ================================================== */
// router.post(
//   "/orders/:id/shippo-create",
//   authenticateToken,
//   requireAdmin,
//   async (req, res) => {
//     try {
//       const orderId = req.params.id;
//       const { carrier } = req.body || {};

//       if (!carrier) {
//         return res.status(400).json({ error: "carrier is required" });
//       }

//       // ── Load order + user info ─────────────────────────────────────
//       const [rows] = await db.execute(
//         `SELECT 
//            o.*,
//            u.first_name,
//            u.last_name,
//            u.email
//          FROM orders o
//          JOIN users u ON o.user_id = u.id
//          WHERE o.id = ?`,
//         [orderId]
//       );

//       if (!rows.length) {
//         return res.status(404).json({ error: "Order not found" });
//       }

//       const order = rows[0];

//       // ── Parse shipping address ─────────────────────────────────────
//       let shippingAddress = null;
//       if (order.shipping_address) {
//         if (typeof order.shipping_address === "string") {
//           try {
//             shippingAddress = JSON.parse(order.shipping_address);
//           } catch (e) {
//             console.error("Failed to parse shipping_address JSON:", e);
//           }
//         } else {
//           shippingAddress = order.shipping_address;
//         }
//       }

//       const shippingCountry =
//         shippingAddress?.country || shippingAddress?.Country || null;

//       // ── Guard: Canada only ─────────────────────────────────────────
//       if (
//         !shippingCountry ||
//         String(shippingCountry).toUpperCase() !== "CA"
//       ) {
//         return res.status(400).json({
//           error: "Shippo integration only allowed for Canada orders",
//         });
//       }

//       if (order.payment_status !== "paid") {
//         return res.status(400).json({
//           error: "Shippo shipment can only be created for paid orders",
//         });
//       }

//       if (order.shippo_tracking_number && order.shippo_carrier) {
//         return res.status(400).json({
//           error: "Shippo shipment already exists for this order",
//         });
//       }

//       // ── Build addresses ────────────────────────────────────────────
//       const toPostal = (
//         shippingAddress?.postal_code ||
//         shippingAddress?.zip ||
//         ""
//       ).replace(/\s+/g, "");

//       const toAddress = {
//         name:
//           `${order.first_name || ""} ${order.last_name || ""}`.trim() ||
//           shippingAddress?.name ||
//           "Customer",
//         email: order.email || shippingAddress?.email || undefined,
//         street1: shippingAddress?.address1 || shippingAddress?.line1,
//         street2: shippingAddress?.address2 || shippingAddress?.line2 || "",
//         city: shippingAddress?.city,
//         state: shippingAddress?.state || shippingAddress?.province,
//         zip: toPostal,
//         country: shippingCountry,
//         phone: shippingAddress?.phone || undefined,
//       };

//       const fromPostal = (process.env.SHIPPO_FROM_ZIP || "M5V1E3").replace(
//         /\s+/g,
//         ""
//       );

//       const fromAddress = {
//         name: process.env.SHIPPO_FROM_NAME || "Nordica Plastics",
//         street1: process.env.SHIPPO_FROM_STREET1 || "Default Street",
//         street2: process.env.SHIPPO_FROM_STREET2 || "",
//         city: process.env.SHIPPO_FROM_CITY || "Toronto",
//         state: process.env.SHIPPO_FROM_STATE || "ON",
//         zip: fromPostal,
//         country: process.env.SHIPPO_FROM_COUNTRY || "CA",
//         phone: process.env.SHIPPO_FROM_PHONE || undefined,
//         email: process.env.SHIPPO_FROM_EMAIL || undefined,
//       };

//       const parcel = {
//         length: "10",
//         width: "10",
//         height: "5",
//         distance_unit: "cm",
//         weight: "0.5",
//         mass_unit: "kg",
//       };

//       const apiToken = process.env.SHIPPO_API_TOKEN;
//       if (!apiToken) {
//         return res
//           .status(500)
//           .json({ error: "SHIPPO_API_TOKEN is not configured" });
//       }

//       // ── Step 1: Create shipment via REST ───────────────────────────
//       const shipmentResp = await fetch("https://api.goshippo.com/shipments/", {
//         method: "POST",
//         headers: {
//           "Content-Type": "application/json",
//           Authorization: `ShippoToken ${apiToken}`,
//         },
//         body: JSON.stringify({
//           address_from: fromAddress,
//           address_to: toAddress,
//           parcels: [parcel],
//           carrier_accounts: [carrier],
//         }),
//       });

//       const shipment = await shipmentResp.json();

//       if (!shipmentResp.ok) {
//         console.error("Shippo shipment error:", shipment);
//         return res.status(400).json({
//           error: "Shippo shipment creation failed",
//           details: shipment,
//         });
//       }

//       if (!shipment?.rates?.length) {
//         return res.status(400).json({
//           error: "No rates returned from Shippo for this shipment",
//           details: shipment,
//         });
//       }

//       // ── Pick cheapest rate ─────────────────────────────────────────
//       const rate = shipment.rates.reduce((best, r) => {
//         if (!best) return r;
//         return parseFloat(r.amount || "0") < parseFloat(best.amount || "0")
//           ? r
//           : best;
//       }, null);

//       if (!rate) {
//         return res
//           .status(400)
//           .json({ error: "Failed to select rate for Shippo shipment" });
//       }

//       // ── Step 2: Buy label via REST ─────────────────────────────────
//       const txResp = await fetch("https://api.goshippo.com/transactions/", {
//         method: "POST",
//         headers: {
//           "Content-Type": "application/json",
//           Authorization: `ShippoToken ${apiToken}`,
//         },
//         body: JSON.stringify({
//           rate: rate.object_id,
//           label_file_type: "PDF",
//           async: false,
//         }),
//       });

//       const transaction = await txResp.json();

//       if (!txResp.ok || transaction.status !== "SUCCESS") {
//         console.error("Shippo transaction error:", transaction);
//         return res.status(400).json({
//           error: "Shippo transaction failed",
//           details: transaction,
//         });
//       }

//       const trackingNumber =
//         transaction.tracking_number || transaction.trackingNumber || null;
//       const trackingCarrier =
//         transaction.tracking_carrier ||
//         transaction.trackingCarrier ||
//         transaction.carrier ||
//         "canada_post";

//       // ──────────────────────────────────────────────────────────────
//       // ✅ CHANGE 1: Also save shippo_label_url to DB
//       // ──────────────────────────────────────────────────────────────
//       const labelUrl =
//         transaction.label_url || transaction.labelUrl || null;

//       await db.execute(
//         `UPDATE orders
//          SET shippo_tracking_number = ?,
//              shippo_carrier         = ?,
//              shippo_tracking_status = 'UNKNOWN',
//              shippo_tracking_raw    = ?,
//              shippo_label_url       = ?
//          WHERE id = ?`,
//         [
//           trackingNumber,
//           trackingCarrier,
//           JSON.stringify(transaction),
//           labelUrl,          // ← NEW
//           orderId,
//         ]
//       );

//       // ──────────────────────────────────────────────────────────────
//       // ✅ CHANGE 2: Send shipment-created email to customer
//       // Non-fatal — a failed email must NOT fail the API response.
//       // ──────────────────────────────────────────────────────────────
//       try {
//         await sendShipmentCreatedEmail({
//           to: order.email,
//           name:
//             `${order.first_name || ""} ${order.last_name || ""}`.trim() ||
//             "Customer",
//           orderNumber: order.id,
//           trackingNumber,
//           carrier: trackingCarrier,
//           labelUrl,
//         });
//       } catch (emailErr) {
//         console.error(
//           "⚠️ Shipment created email failed (non-fatal):",
//           emailErr.message
//         );
//       }

//       res.json({
//         success: true,
//         tracking_number: trackingNumber,
//         carrier: trackingCarrier,
//         label_url: labelUrl,
//       });
//     } catch (error) {
//       console.error("Shippo create shipment error:", error);
//       res.status(500).json({
//         error: "Failed to create Shippo shipment",
//         details: error.message,
//       });
//     }
//   }
// );

// /* ================================================== */
// /* 7️⃣ Shippo webhook — auto status updates           */
// /* POST /api/admin/shippo/webhook                     */
// /*                                                    */
// /* (kept here as secondary entry; primary is the      */
// /*  dedicated shippoWebhook.js route — see that file) */
// /* ================================================== */
// router.post("/webhook", express.json(), async (req, res) => {
//   try {
//     console.log("✅ Shippo webhook hit (admin router)");

//     const payload = req.body;
//     const event = payload?.event || payload?.type || null;
//     const tracking = payload?.data || payload;

//     if (event && event !== "track_updated") {
//       return res.status(200).json({ received: true, ignored: true });
//     }

//     const carrier = tracking?.carrier;
//     const trackingNumber = tracking?.tracking_number;

//     if (!carrier || !trackingNumber) {
//       console.warn("Webhook missing carrier/tracking_number", payload);
//       return res.status(200).json({ received: true, missing: true });
//     }

//     const mapped = mapShippoTracking(tracking);

//     await db.execute(
//       `UPDATE orders
//        SET shippo_tracking_status = ?,
//            shippo_tracking_raw    = ?
//        WHERE shippo_tracking_number = ?
//          AND shippo_carrier = ?`,
//       [mapped.status, JSON.stringify(tracking), trackingNumber, carrier]
//     );

//     console.log(`✅ Webhook updated tracking: ${trackingNumber}`);

//     res.status(200).json({ received: true, trackingNumber, carrier });
//   } catch (err) {
//     console.error("❌ Shippo webhook error:", err);
//     res.status(200).json({ received: true, error: true });
//   }
// });

// /* ================================================== */
// /* 8️⃣ Customer orders list                           */
// /* GET /api/admin/shippo/customers/:id/orders         */
// /* ================================================== */
// router.get(
//   "/customers/:id/orders",
//   authenticateToken,
//   requireAdmin,
//   async (req, res) => {
//     try {
//       const { id } = req.params;
//       const { page = 1, limit = 10 } = req.query;
//       const pageNum = parseInt(page, 10) || 1;
//       const limitNum = parseInt(limit, 10) || 10;
//       const offset = (pageNum - 1) * limitNum;

//       const [orders] = await db.execute(
//         `SELECT 
//            o.*,
//            JSON_OBJECT(
//              'first_name', u.first_name,
//              'last_name',  u.last_name,
//              'email',      u.email
//            ) AS user,
//            JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.country')) AS shipping_country
//          FROM orders o
//          JOIN users u ON o.user_id = u.id
//          WHERE o.user_id = ?
//          ORDER BY o.order_date DESC
//          LIMIT ? OFFSET ?`,
//         [id, limitNum, offset]
//       );

//       const [count] = await db.execute(
//         "SELECT COUNT(*) AS total FROM orders WHERE user_id = ?",
//         [id]
//       );

//       orders.forEach((order) => {
//         if (
//           order.shipping_address &&
//           typeof order.shipping_address === "string"
//         ) {
//           order.shipping_address = JSON.parse(order.shipping_address);
//         }
//         if (order.user && typeof order.user === "string") {
//           order.user = JSON.parse(order.user);
//         }
//       });

//       res.json({
//         orders,
//         pagination: { page: pageNum, total: count[0].total },
//       });
//     } catch (error) {
//       console.error("Customer orders error:", error);
//       res.status(500).json({ error: "Failed to fetch customer orders" });
//     }
//   }
// );

// export default router;

//testing 2




/**
 * routes/shippoAdmin.js
 * Mounted at: /api/admin/shippo
 *
 * All Shippo-related admin routes.
 *
 * Endpoint map
 * ─────────────────────────────────────────────────────────────────
 * GET  /carriers                         List carrier accounts     [GAP 1]
 * GET  /orders/canada                    Canada-only order list    [GAP 2]
 * GET  /orders/:id                       Full order detail         [GAP 2]
 * POST /orders/:id/shippo-create         Create shipment + label   [GAP 4]
 * GET  /orders/:id/tracking-history      Full scan timeline        [GAP 5]
 * GET  /orders/:id/track                 Live tracking refresh
 * PUT  /orders/:id/tracking              Manual tracking save
 * GET  /orders                           Shippo orders (raw)
 * GET  /transactions                     Shippo transactions (raw)
 * GET  /customers/:id/orders             Customer order history
 */

import express from "express";
import { Shippo } from "shippo";
import db from "../config/database.js";
import { authenticateToken, requireAdmin } from "../middleware/auth.js";
import { sendShipmentCreatedEmail } from "../utils/mailer.js";
import shippoService from "../services/shippoService.js";

const router = express.Router();

/* ─────────────────────────────────────────────────── */
/* Shippo SDK client (exported for other modules)      */
/* ─────────────────────────────────────────────────── */
const shippo = new Shippo({
  apiKeyHeader: process.env.SHIPPO_API_TOKEN,
  shippoApiVersion: "2018-02-08",
});
export const shippoClient = shippo;

/* ─────────────────────────────────────────────────── */
/* Shared helpers                                      */
/* ─────────────────────────────────────────────────── */

/** Normalise a Shippo trackingStatus response */
const mapShippoTracking = (t) => ({
  status: t?.tracking_status?.status || null,
  substatus: t?.tracking_status?.substatus || null,
  statusDate: t?.tracking_status?.status_date || null,
  location: t?.tracking_status?.location || null,
  carrier: t?.carrier || null,
  trackingNumber: t?.tracking_number || null,
  serviceLevel: t?.servicelevel?.name || null,
  eta: t?.eta || null,
  history: t?.tracking_history || [],
});

/** Safe JSON parse — returns null on failure */
const safeJson = (val) => {
  if (!val) return null;
  if (typeof val === "object") return val;
  try { return JSON.parse(val); } catch { return null; }
};

/** Build a full name string */
const fullName = (first, last) =>
  `${first || ""} ${last || ""}`.trim() || "Customer";

/** Centralised Shippo REST helper — keeps auth DRY */
// const shippoFetch = async (path, options = {}) => {
//   const apiToken = process.env.SHIPPO_API_TOKEN;
//   if (!apiToken) throw new Error("SHIPPO_API_TOKEN is not configured");

//   const resp = await fetch(`https://api.goshippo.com${path}`, {
//     ...options,
//     headers: {
//       "Content-Type": "application/json",
//       Authorization: `ShippoToken ${apiToken}`,
//       ...(options.headers || {}),
//     },
//   });
//   const data = await resp.json();
//   return { ok: resp.ok, status: resp.status, data };
// };


//testing for postman
const shippoFetch = async (path, options = {}) => {
  const apiToken = process.env.SHIPPO_API_TOKEN;

  if (!apiToken) throw new Error("SHIPPO_API_TOKEN is not set in .env");

  const resp = await fetch(`https://api.goshippo.com${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `ShippoToken ${apiToken}`,
      ...(options.headers || {}),
    },
  });

  // Read as text first — never crash on empty body
  const text = await resp.text();

  console.log("🌐 Shippo RAW response:", resp.status, "|", text.slice(0, 500));

  if (!text) {
    throw new Error(`Shippo returned empty body — HTTP ${resp.status}. Check your API token.`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Shippo returned non-JSON (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }

  return { ok: resp.ok, status: resp.status, data };
};
/* ══════════════════════════════════════════════════════════ */
/* GAP 1 — List carrier accounts                            */
/* GET /api/admin/shippo/carriers                           */
/*                                                          */
/* Returns every carrier configured in the Shippo account  */
/* so the CRM can render a dropdown instead of forcing the  */
/* admin to type an account ID manually.                    */
/* ══════════════════════════════════════════════════════════ */
// router.get(
//   "/carriers",
//   authenticateToken,
//   requireAdmin,
//   async (_req, res) => {
//     try {
//       const { ok, data } = await shippoFetch("/carrier-accounts/?results=100");

//       if (!ok) {
//         console.error("❌ Carrier accounts fetch failed:", data);
//         return res.status(502).json({ error: "Failed to fetch carrier accounts from Shippo" });
//       }

//       const carriers = (data.results || []).map((c) => ({
//         id:        c.object_id,   // ← pass this as `carrier` when creating a shipment
//         carrier:   c.carrier,     // "canada_post" | "fedex" | "ups" etc.
//         accountId: c.account_id || null,
//         active:    c.active,
//         isDefault: c.is_default_or_primary || false,
//       }));

//       res.json({ success: true, data: carriers });
//     } catch (err) {
//       console.error("❌ /carriers error:", err);
//       res.status(500).json({ error: "Failed to list carrier accounts" });
//     }
//   }
// );




//testing for postman 
router.get(
  "/carriers",
  authenticateToken,
  requireAdmin,
  async (_req, res) => {
    try {
      const response = await shippo.carrierAccounts.list({
        results: 100,
        page: 1,
      });

      console.log("📦 Carrier accounts raw:", JSON.stringify(response).slice(0, 500));

      const carriers = (response.results || []).map((c) => ({
        id: c.objectId || c.object_id,
        carrier: c.carrier,
        accountId: c.accountId || c.account_id || null,
        active: c.active,
        isDefault: c.isDefaultOrPrimary || c.is_default_or_primary || false,
      }));

      res.json({ success: true, data: carriers });
    } catch (err) {
      console.error("❌ /carriers error:", err.message);
      res.status(500).json({ error: "Failed to list carrier accounts", detail: err.message });
    }
  }
);
/* ══════════════════════════════════════════════════════════ */
/* Trackings (detailed) from Shippo                         */
/* GET /api/admin/shippo/trackings                          */
/* ══════════════════════════════════════════════════════════ */
router.get(
  "/trackings",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      console.log("📊 GET /trackings (Shippo trackingStatus API)");

      const { status, page = 1 } = req.query;

      const transactions = await shippo.transactions.list({
        page: Number(page),
        results: 20,
      });

      const results = transactions.results || [];

      const detailed = await Promise.all(
        results.map(async (t) => {
          const trackingNumber = t.tracking_number || t.trackingNumber || null;
          const carrier = t.tracking_carrier || t.trackingCarrier || t.carrier || null;

          let tracking = null;
          if (trackingNumber && carrier) {
            try {
              const ts = await shippo.trackingStatus.get(carrier, trackingNumber);
              tracking = mapShippoTracking(ts);
            } catch (err) {
              console.error(
                "⚠️ trackingStatus.get failed for",
                carrier,
                trackingNumber,
                err
              );
            }
          }

          const trackingStatus =
            tracking?.status || t.tracking_status || t.trackingStatus || null;

          return {
            transactionId: t.object_id,
            orderId: t.order || null,
            shippo_tracking_number: trackingNumber,
            shippo_carrier: carrier,
            shippo_tracking_status: trackingStatus,
            tracking,
            tracking_raw: tracking || t,
          };
        })
      );

      const filtered = status
        ? detailed.filter(
            (d) =>
              (d.shippo_tracking_status || "").toUpperCase() ===
              String(status).toUpperCase()
          )
        : detailed;

      res.json({
        success: true,
        data: filtered,
        pagination: {
          page: transactions.page || Number(page),
          next: transactions.next,
          previous: transactions.previous,
        },
      });
    } catch (err) {
      console.error("❌ List Shippo trackings error:", err);
      res.status(500).json({ error: "Failed to list Shippo trackings" });
    }
  }
);

/* ══════════════════════════════════════════════════════════ */
/* GAP 2a — Canada orders list                              */
/* GET /api/admin/shippo/orders/canada                      */
/*   ?page=1 &limit=20 &status=shipped &shippo_status=TRANSIT */
/*                                                          */
/* Filtered view: CA orders only, enriched with all Shippo  */
/* columns so admin can see shipping state at a glance.     */
/* ══════════════════════════════════════════════════════════ */
router.get(
  "/orders/canada",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const pageNum = Math.max(1, parseInt(req.query.page || "1", 10));
      const limitNum = Math.min(100, parseInt(req.query.limit || "20", 10));
      const offset = (pageNum - 1) * limitNum;

      const conditions = [
        "JSON_VALID(o.shipping_address) = 1",
        "UPPER(JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.country'))) = 'CA'",
      ];
      const params = [];

      if (req.query.status) {
        conditions.push("o.status = ?");
        params.push(req.query.status);
      }
      if (req.query.shippo_status) {
        conditions.push("o.shippo_tracking_status = ?");
        params.push(req.query.shippo_status.toUpperCase());
      }

      const where = conditions.join(" AND ");

      const [orders] = await db.execute(
        `SELECT
           o.id, o.order_date, o.status, o.payment_status, o.total_amount,
           o.shipping_address,
           o.shippo_tracking_number, o.shippo_carrier,
           o.shippo_tracking_status, o.shippo_label_url,
           u.first_name, u.last_name, u.email
         FROM orders o
         JOIN users u ON o.user_id = u.id
         WHERE ${where}
         ORDER BY o.order_date DESC
         LIMIT ? OFFSET ?`,
        [...params, limitNum, offset]
      );

      const [[{ total }]] = await db.execute(
        `SELECT COUNT(*) AS total FROM orders o WHERE ${where}`,
        params
      );

      const mapped = orders.map((o) => ({
        id: o.id,
        orderDate: o.order_date,
        status: o.status,
        paymentStatus: o.payment_status,
        totalAmount: o.total_amount,
        shippingAddress: safeJson(o.shipping_address),
        customer: { firstName: o.first_name, lastName: o.last_name, email: o.email },
        shippo: {
          trackingNumber: o.shippo_tracking_number || null,
          carrier: o.shippo_carrier || null,
          trackingStatus: o.shippo_tracking_status || null,
          labelUrl: o.shippo_label_url || null,
          hasLabel: !!o.shippo_label_url,
          hasTracking: !!o.shippo_tracking_number,
        },
      }));

      res.json({
        success: true,
        data: mapped,
        pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
      });
    } catch (err) {
      console.error("❌ Canada orders list error:", err);
      res.status(500).json({ error: "Failed to list Canada orders" });
    }
  }
);

/* ══════════════════════════════════════════════════════════ */
/* GAP 2b — Single order full detail                        */
/* GET /api/admin/shippo/orders/:id                         */
/*                                                          */
/* Returns every Shippo field including label URL and       */
/* parsed tracking history — all from cached DB data,       */
/* zero extra Shippo API calls.                             */
/* ══════════════════════════════════════════════════════════ */
router.get(
  "/orders/:id",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const [rows] = await db.execute(
        `SELECT o.*, u.first_name, u.last_name, u.email
         FROM orders o
         JOIN users u ON o.user_id = u.id
         WHERE o.id = ?`,
        [req.params.id]
      );

      if (!rows.length) return res.status(404).json({ error: "Order not found" });

      const o = rows[0];
      const trackingRaw = safeJson(o.shippo_tracking_raw);

      const trackingHistory = (trackingRaw?.tracking_history || [])
        .map((h) => ({
          status: h.status,
          substatus: h.substatus || null,
          statusDate: h.status_date || null,
          message: h.status_details || null,
          location: h.location
            ? {
              city: h.location.city || null, state: h.location.state || null,
              country: h.location.country || null, zip: h.location.zip || null
            }
            : null,
        }))
        .reverse(); // most-recent first

      res.json({
        success: true,
        data: {
          id: o.id,
          orderDate: o.order_date,
          status: o.status,
          paymentStatus: o.payment_status,
          totalAmount: o.total_amount,
          shippingAddress: safeJson(o.shipping_address),
          customer: { firstName: o.first_name, lastName: o.last_name, email: o.email },
          shippo: {
            trackingNumber: o.shippo_tracking_number || null,
            carrier: o.shippo_carrier || null,
            trackingStatus: o.shippo_tracking_status || null,
            labelUrl: o.shippo_label_url || null,
            eta: trackingRaw?.eta || null,
            currentLocation: trackingRaw?.tracking_status?.location || null,
            trackingHistory,
            hasLabel: !!o.shippo_label_url,
            hasTracking: !!o.shippo_tracking_number,
          },
        },
      });
    } catch (err) {
      console.error("❌ Order detail error:", err);
      res.status(500).json({ error: "Failed to fetch order detail" });
    }
  }
);

/* ══════════════════════════════════════════════════════════ */
/* GAP 5 — Full tracking history / scan timeline            */
/* GET /api/admin/shippo/orders/:id/tracking-history        */
/*                                                          */
/* Returns each carrier scan event formatted for a CRM      */
/* timeline component.  Reads from cached DB first;         */
/* falls back to live Shippo API only when cache is empty.  */
/* ══════════════════════════════════════════════════════════ */
router.get(
  "/orders/:id/tracking-history",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const [rows] = await db.execute(
        `SELECT shippo_tracking_number, shippo_carrier,
                shippo_tracking_status, shippo_tracking_raw
         FROM orders WHERE id = ?`,
        [req.params.id]
      );

      if (!rows.length) return res.status(404).json({ error: "Order not found" });

      const order = rows[0];

      if (!order.shippo_tracking_number) {
        return res.json({
          success: true,
          data: { events: [], currentStatus: null, carrier: null, trackingNumber: null, eta: null },
        });
      }

      let raw = safeJson(order.shippo_tracking_raw);
      let history = raw?.tracking_history || [];
      let current = raw?.tracking_status || null;
      let eta = raw?.eta || null;

      // Live refresh only when no history is cached yet
      if (!history.length) {
        try {
          const live = await shippo.trackingStatus.get(
            order.shippo_carrier,
            order.shippo_tracking_number
          );
          history = live?.tracking_history || [];
          current = live?.tracking_status || null;
          eta = live?.eta || null;

          await db.execute(
            `UPDATE orders
             SET shippo_tracking_status = ?, shippo_tracking_raw = ?
             WHERE id = ?`,
            [current?.status || null, JSON.stringify(live), req.params.id]
          );
        } catch (apiErr) {
          console.error("⚠️ Live tracking refresh failed:", apiErr.message);
        }
      }

      const events = history
        .map((h, index) => ({
          index,
          status: h.status,
          substatus: h.substatus || null,
          statusDate: h.status_date || null,
          message: h.status_details || null,
          location: h.location
            ? {
              city: h.location.city || null, state: h.location.state || null,
              country: h.location.country || null, zip: h.location.zip || null
            }
            : null,
        }))
        .reverse(); // most-recent first

      res.json({
        success: true,
        data: {
          currentStatus: current?.status || order.shippo_tracking_status || null,
          carrier: order.shippo_carrier,
          trackingNumber: order.shippo_tracking_number,
          eta,
          events,
        },
      });
    } catch (err) {
      console.error("❌ Tracking history error:", err);
      res.status(500).json({ error: "Failed to fetch tracking history" });
    }
  }
);

/* ══════════════════════════════════════════════════════════ */
/* GAP 4 — Create Shippo shipment + buy label               */
/* POST /api/admin/shippo/orders/:id/shippo-create          */
/* Body: { carrier: "<shippo_carrier_account_object_id>" }  */
/*                                                          */
/* Production changes vs previous version:                  */
/*  ✅ order.status flipped to "shipped" on success          */
/*  ✅ shippo_label_url saved to DB                          */
/*  ✅ shippo_tracking_status set to PRE_TRANSIT             */
/*  ✅ Customer email sent (non-fatal)                       */
/* ══════════════════════════════════════════════════════════ */
// router.post(
//   "/orders/:id/shippo-create",
//   authenticateToken,
//   requireAdmin,
//   async (req, res) => {
//     try {
//       const orderId = req.params.id;
//       const { carrier } = req.body || {};

//       if (!carrier) {
//         return res.status(400).json({ error: "carrier (account object_id) is required" });
//       }

//       // ── Load order ─────────────────────────────────────────────────
//       const [rows] = await db.execute(
//         `SELECT o.*, u.first_name, u.last_name, u.email
//          FROM orders o JOIN users u ON o.user_id = u.id
//          WHERE o.id = ?`,
//         [orderId]
//       );
//       if (!rows.length) return res.status(404).json({ error: "Order not found" });

//       const order           = rows[0];
//       const shippingAddress = safeJson(order.shipping_address);
//       const shippingCountry = (shippingAddress?.country || shippingAddress?.Country || "")
//         .toUpperCase();

//       // ── Guards ─────────────────────────────────────────────────────
//       if (shippingCountry !== "CA") {
//         return res.status(400).json({ error: "Shippo integration only allowed for Canada orders" });
//       }
//       if (order.payment_status !== "paid") {
//         return res.status(400).json({ error: "Order must be paid before creating a shipment" });
//       }
//       if (order.shippo_tracking_number && order.shippo_carrier) {
//         return res.status(409).json({ error: "Shippo shipment already exists for this order" });
//       }

//       // ── Addresses ──────────────────────────────────────────────────
//       const toAddress = {
//         name:    fullName(order.first_name, order.last_name),
//         email:   order.email || undefined,
//         street1: shippingAddress?.address1 || shippingAddress?.line1,
//         street2: shippingAddress?.address2 || shippingAddress?.line2 || "",
//         city:    shippingAddress?.city,
//         state:   shippingAddress?.state || shippingAddress?.province,
//         zip:     (shippingAddress?.postal_code || shippingAddress?.zip || "").replace(/\s+/g, ""),
//         country: shippingCountry,
//         phone:   shippingAddress?.phone || undefined,
//       };

//       const fromAddress = {
//         name:    process.env.SHIPPO_FROM_NAME    || "Nordica Plastics",
//         street1: process.env.SHIPPO_FROM_STREET1 || "Default Street",
//         street2: process.env.SHIPPO_FROM_STREET2 || "",
//         city:    process.env.SHIPPO_FROM_CITY    || "Toronto",
//         state:   process.env.SHIPPO_FROM_STATE   || "ON",
//         zip:     (process.env.SHIPPO_FROM_ZIP    || "M5V1E3").replace(/\s+/g, ""),
//         country: process.env.SHIPPO_FROM_COUNTRY || "CA",
//         phone:   process.env.SHIPPO_FROM_PHONE   || undefined,
//         email:   process.env.SHIPPO_FROM_EMAIL   || undefined,
//       };

//       // ── Step 1: Create shipment → get rates ────────────────────────
//       const shipmentRes = await shippoFetch("/shipments/", {
//         method: "POST",
//         body: JSON.stringify({
//           address_from: fromAddress, address_to: toAddress,
//           parcels: [{ length: "10", width: "10", height: "5",
//                       distance_unit: "cm", weight: "0.5", mass_unit: "kg" }],
//           carrier_accounts: [carrier],
//         }),
//       });

//       if (!shipmentRes.ok) {
//         console.error("❌ Shipment creation failed:", shipmentRes.data);
//         return res.status(400).json({ error: "Shippo shipment creation failed", details: shipmentRes.data });
//       }

//       const { rates } = shipmentRes.data;

//       if (!rates?.length) {
//         return res.status(400).json({
//           error: "No rates returned — check address details and carrier configuration",
//         });
//       }

//       // Pick cheapest rate
//       const rate = rates.reduce((best, r) =>
//         parseFloat(r.amount || "0") < parseFloat(best?.amount ?? "Infinity") ? r : best
//       , null);

//       // ── Step 2: Buy label ──────────────────────────────────────────
//       const txRes = await shippoFetch("/transactions/", {
//         method: "POST",
//         body: JSON.stringify({ rate: rate.object_id, label_file_type: "PDF", async: false }),
//       });

//       if (!txRes.ok || txRes.data?.status !== "SUCCESS") {
//         console.error("❌ Label purchase failed:", txRes.data);
//         return res.status(400).json({ error: "Shippo label purchase failed", details: txRes.data });
//       }

//       const tx              = txRes.data;
//       const trackingNumber  = tx.tracking_number  || tx.trackingNumber  || null;
//       const trackingCarrier = tx.tracking_carrier || tx.trackingCarrier || tx.carrier || "canada_post";
//       const labelUrl        = tx.label_url        || tx.labelUrl        || null;

//       // ── Step 3: Persist everything + flip order status to "shipped" ─
//       await db.execute(
//         `UPDATE orders
//          SET shippo_tracking_number = ?,
//              shippo_carrier         = ?,
//              shippo_tracking_status = 'PRE_TRANSIT',
//              shippo_tracking_raw    = ?,
//              shippo_label_url       = ?,
//              status                 = 'shipped'
//          WHERE id = ?`,
//         [trackingNumber, trackingCarrier, JSON.stringify(tx), labelUrl, orderId]
//       );

//       // ── Step 4: Email customer (non-fatal) ─────────────────────────
//       try {
//         await sendShipmentCreatedEmail({
//           to:          order.email,
//           name:        fullName(order.first_name, order.last_name),
//           orderNumber: order.id,
//           trackingNumber,
//           carrier:     trackingCarrier,
//           labelUrl,
//         });
//       } catch (emailErr) {
//         console.error("⚠️ Shipment email failed (non-fatal):", emailErr.message);
//       }

//       res.json({
//         success:         true,
//         tracking_number: trackingNumber,
//         carrier:         trackingCarrier,
//         label_url:       labelUrl,
//         order_status:    "shipped",
//       });
//     } catch (err) {
//       console.error("❌ shippo-create error:", err);
//       res.status(500).json({ error: "Failed to create Shippo shipment", details: err.message });
//     }
//   }
// );



//testing for postman (Note : Remove after testing)
router.post(
  "/orders/:id/shippo-create",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const orderId = req.params.id;
      const { carrier } = req.body || {};

      if (!carrier) {
        return res.status(400).json({ error: "carrier (account object_id) is required" });
      }

      // ── Load order ─────────────────────────────────────────────────
      const [rows] = await db.execute(
        `SELECT o.*, u.first_name, u.last_name, u.email
         FROM orders o JOIN users u ON o.user_id = u.id
         WHERE o.id = ?`,
        [orderId]
      );

      if (!rows.length) {
        return res.status(404).json({ error: "Order not found" });
      }

      const order = rows[0];
      const shippingAddress = safeJson(order.shipping_address);
      const shippingCountry = (
        shippingAddress?.country || shippingAddress?.Country || ""
      ).toUpperCase();

      // ── Guards ─────────────────────────────────────────────────────
      if (shippingCountry !== "CA") {
        return res.status(400).json({ error: "Shippo integration only allowed for Canada orders" });
      }
      if (order.payment_status !== "paid") {
        return res.status(400).json({ error: "Order must be paid before creating a shipment" });
      }
      if (order.shippo_tracking_number && order.shippo_carrier) {
        return res.status(409).json({ error: "Shippo shipment already exists for this order" });
      }

      // ── Build addresses ────────────────────────────────────────────
      const toAddress = {
        name: fullName(order.first_name, order.last_name),
        email: order.email || undefined,
        street1: shippingAddress?.address1 || shippingAddress?.line1,
        street2: shippingAddress?.address2 || shippingAddress?.line2 || "",
        city: shippingAddress?.city,
        state: shippingAddress?.state || shippingAddress?.province,
        zip: (shippingAddress?.postal_code || shippingAddress?.zip || "").replace(/\s+/g, ""),
        country: shippingCountry,
        phone: shippingAddress?.phone || undefined,
      };

      const fromAddress = {
        name: process.env.SHIPPO_FROM_NAME || "Nordica Plastics",
        street1: process.env.SHIPPO_FROM_STREET1 || "Default Street",
        street2: process.env.SHIPPO_FROM_STREET2 || "",
        city: process.env.SHIPPO_FROM_CITY || "Toronto",
        state: process.env.SHIPPO_FROM_STATE || "ON",
        zip: (process.env.SHIPPO_FROM_ZIP || "M5V1E3").replace(/\s+/g, ""),
        country: process.env.SHIPPO_FROM_COUNTRY || "CA",
        phone: process.env.SHIPPO_FROM_PHONE || undefined,
        email: process.env.SHIPPO_FROM_EMAIL || undefined,
      };

      // ── Parcel (above Canada Post minimums) ───────────────────────
      const parcel = {
        length: "30",
        width: "20",
        height: "15",
        distance_unit: "cm",
        weight: "1",
        mass_unit: "kg",
      };

      // ── Step 1: Create shipment → get rates ────────────────────────
      // async: false forces Shippo to wait and return rates immediately
      const shipmentRes = await shippoFetch("/shipments/", {
        method: "POST",
        body: JSON.stringify({
          address_from: fromAddress,
          address_to: toAddress,
          parcels: [parcel],
          carrier_accounts: [carrier],
          async: false,
        }),
      });

      if (!shipmentRes.ok) {
        console.error("❌ Shipment creation failed:", shipmentRes.data);
        return res.status(400).json({
          error: "Shippo shipment creation failed",
          details: shipmentRes.data,
        });
      }

      const { rates, status: shipmentStatus, messages } = shipmentRes.data;

      // Debug logs — remove after testing
      console.log("🚢 Shipment status:", shipmentStatus);
      console.log("📊 Rates count:", rates?.length);
      console.log("💬 Shippo messages:", JSON.stringify(messages));
      console.log("📋 First rate:", JSON.stringify(rates?.[0])?.slice(0, 300));

      if (!rates?.length) {
        return res.status(400).json({
          error: "No rates returned from Shippo",
          shipmentStatus,
          messages: messages || [],
          hint: "Check Shippo messages above for the exact reason",
        });
      }

      // ── Pick cheapest rate ─────────────────────────────────────────
      const rate = rates.reduce((best, r) =>
        parseFloat(r.amount || "0") < parseFloat(best?.amount ?? "Infinity") ? r : best
        , null);

      console.log("✅ Selected rate:", rate?.servicelevel_name, rate?.amount, rate?.currency);

      // ── Step 2: Buy label ──────────────────────────────────────────
      const txRes = await shippoFetch("/transactions/", {
        method: "POST",
        body: JSON.stringify({
          rate: rate.object_id,
          label_file_type: "PDF",
          async: false,
        }),
      });

      if (!txRes.ok || txRes.data?.status !== "SUCCESS") {
        console.error("❌ Label purchase failed:", txRes.data);
        return res.status(400).json({
          error: "Shippo label purchase failed",
          details: txRes.data,
        });
      }

      const tx = txRes.data;
      const trackingNumber = tx.tracking_number || tx.trackingNumber || null;
      const trackingCarrier = tx.tracking_carrier || tx.trackingCarrier || tx.carrier || "canada_post";
      const labelUrl = tx.label_url || tx.labelUrl || null;

      console.log("🏷️ Label bought:", trackingNumber, labelUrl);

      // ── Step 3: Save to DB + flip order status to shipped ──────────
      await db.execute(
        `UPDATE orders
         SET shippo_tracking_number = ?,
             shippo_carrier         = ?,
             shippo_tracking_status = 'PRE_TRANSIT',
             shippo_tracking_raw    = ?,
             shippo_label_url       = ?,
             status                 = 'shipped'
         WHERE id = ?`,
        [trackingNumber, trackingCarrier, JSON.stringify(tx), labelUrl, orderId]
      );

      // ── Step 4: Email customer (non-fatal) ─────────────────────────
      try {
        await sendShipmentCreatedEmail({
          to: order.email,
          name: fullName(order.first_name, order.last_name),
          orderNumber: order.id,
          trackingNumber,
          carrier: trackingCarrier,
          labelUrl,
        });
      } catch (emailErr) {
        console.error("⚠️ Shipment email failed (non-fatal):", emailErr.message);
      }

      res.json({
        success: true,
        tracking_number: trackingNumber,
        carrier: trackingCarrier,
        label_url: labelUrl,
        order_status: "shipped",
      });

    } catch (err) {
      console.error("❌ shippo-create error:", err);
      res.status(500).json({
        error: "Failed to create Shippo shipment",
        details: err.message,
      });
    }
  }
);
/* ══════════════════════════════════════════════════════════ */
/* Manual tracking save                                     */
/* PUT /api/admin/shippo/orders/:id/tracking                */
/* ══════════════════════════════════════════════════════════ */
router.put(
  "/orders/:id/tracking",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const { tracking_number, carrier } = req.body;
      if (!tracking_number || !carrier) {
        return res.status(400).json({ error: "tracking_number and carrier are required" });
      }

      const [result] = await db.execute(
        `UPDATE orders
         SET shippo_tracking_number = ?, shippo_carrier = ?, shippo_tracking_status = 'UNKNOWN'
         WHERE id = ?`,
        [tracking_number, carrier, req.params.id]
      );

      if (!result.affectedRows) return res.status(404).json({ error: "Order not found" });

      res.json({ success: true, message: "Tracking info saved" });
    } catch (err) {
      console.error("❌ Save tracking error:", err);
      res.status(500).json({ error: "Failed to save tracking info" });
    }
  }
);

/* ══════════════════════════════════════════════════════════ */
/* Live tracking refresh (admin manual pull)                */
/* GET /api/admin/shippo/orders/:id/track                   */
/* ══════════════════════════════════════════════════════════ */
router.get(
  "/orders/:id/track",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const [rows] = await db.execute(
        `SELECT shippo_tracking_number, shippo_carrier FROM orders WHERE id = ?`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: "Order not found" });

      const { shippo_tracking_number, shippo_carrier } = rows[0];

      if (!shippo_tracking_number || !shippo_carrier) {
        return res.status(400).json({ error: "Order has no Shippo tracking info yet" });
      }

      const tracking = await shippo.trackingStatus.get(shippo_carrier, shippo_tracking_number);
      const mapped = mapShippoTracking(tracking);

      await db.execute(
        `UPDATE orders SET shippo_tracking_status = ?, shippo_tracking_raw = ? WHERE id = ?`,
        [mapped.status, JSON.stringify(tracking), req.params.id]
      );

      res.json({ success: true, data: mapped });
    } catch (err) {
      console.error("❌ Manual tracking refresh error:", err);
      res.status(500).json({ error: "Tracking fetch failed" });
    }
  }
);

/* ══════════════════════════════════════════════════════════ */
/* Shippo orders list (from Shippo cloud, not local DB)     */
/* GET /api/admin/shippo/orders                             */
/* ══════════════════════════════════════════════════════════ */
router.get(
  "/orders",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const orders = await shippo.orders.list({ page: Number(req.query.page || 1), results: 50 });

      res.json({
        success: true,
        data: (orders.results || []).map((o) => ({
          orderId: o.object_id,
          orderNumber: o.order_number || null,
          toName: o.to_address?.name || null,
          toCity: o.to_address?.city || null,
          toCountry: o.to_address?.country || null,
          totalPrice: o.total_price || null,
          currency: o.currency || null,
          status: o.order_status || null,
          createdAt: o.object_created || null,
        })),
        pagination: { page: orders.page, next: orders.next, previous: orders.previous },
      });
    } catch (err) {
      console.error("❌ List Shippo orders error:", err);
      res.status(500).json({ error: "Failed to list Shippo orders" });
    }
  }
);

/* ══════════════════════════════════════════════════════════ */
/* Shippo transactions list                                 */
/* GET /api/admin/shippo/transactions                       */
/* ══════════════════════════════════════════════════════════ */
router.get(
  "/transactions",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const txns = await shippo.transactions.list({ page: Number(req.query.page || 1), results: 50 });

      res.json({
        success: true,
        data: (txns.results || []).map((t) => ({
          transactionId: t.object_id,
          orderId: t.order || null,
          trackingNumber: t.tracking_number || t.trackingNumber || null,
          carrier: t.tracking_carrier || t.trackingCarrier || t.carrier || null,
          trackingStatus: t.tracking_status || t.trackingStatus || null,
          labelUrl: t.label_url || t.labelUrl || null,
          serviceLevel: t.servicelevel_name || t.servicelevelName || null,
          price: t.rate || null,
          currency: t.currency || null,
          createdAt: t.object_created || null,
        })),
        pagination: { page: txns.page, next: txns.next, previous: txns.previous },
      });
    } catch (err) {
      console.error("❌ List transactions error:", err);
      res.status(500).json({ error: "Failed to list Shippo transactions" });
    }
  }
);

/* ══════════════════════════════════════════════════════════ */
/* Customer order history                                   */
/* GET /api/admin/shippo/customers/:id/orders               */
/* ══════════════════════════════════════════════════════════ */
router.get(
  "/customers/:id/orders",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    try {
      const pageNum = Math.max(1, parseInt(req.query.page || "1", 10));
      const limitNum = Math.min(100, parseInt(req.query.limit || "10", 10));
      const offset = (pageNum - 1) * limitNum;

      const [orders] = await db.execute(
        `SELECT o.*,
                JSON_UNQUOTE(JSON_EXTRACT(o.shipping_address, '$.country')) AS shipping_country
         FROM orders o WHERE o.user_id = ?
         ORDER BY o.order_date DESC LIMIT ? OFFSET ?`,
        [req.params.id, limitNum, offset]
      );

      const [[{ total }]] = await db.execute(
        "SELECT COUNT(*) AS total FROM orders WHERE user_id = ?",
        [req.params.id]
      );

      orders.forEach((o) => { o.shipping_address = safeJson(o.shipping_address); });

      res.json({
        orders,
        pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
      });
    } catch (err) {
      console.error("❌ Customer orders error:", err);
      res.status(500).json({ error: "Failed to fetch customer orders" });
    }
  }
);

export default router;