/**
 * =======================================================================
 *  MCF + ORDER FLOW  ——  INTEGRATION TEST (No PayPal Required)
 * =======================================================================
 *  Usage:
 *    node test-mcf.js            → runs all tests
 *    node test-mcf.js inventory  → inventory only
 *    node test-mcf.js preview    → shipping previews only
 *    node test-mcf.js order      → full order creation + fulfillment trigger
 *    node test-mcf.js cancel     → cancel a test MCF order
 *
 *  This script bypasses PayPal entirely and writes a REAL order to the DB,
 *  then submits it to Amazon MCF. Use the test SKUs below.
 * =======================================================================
 */
import 'dotenv/config';
import db from './config/database.js';
import mcfService from './services/mcfService.js';
import Order from './models/Order.js';
import { fulfillOrder } from './services/fulfillmentService.js';
import logger from './utils/logger.js';

// ─── CONFIGURE YOUR TEST HERE ────────────────────────────────────────────────
const TEST_SKU        = 'DIRT LOCK-SW180 WHITE';     // <- one of your real FBA SKUs
const TEST_SKU_2      = 'DIRT LOCK-SW180 BLACK';      // <- second item (optional)
const TEST_ADDRESS    = {
  name:          'Test Tester',
  line1:         '410 Terry Ave N',
  line2:         '',
  city:          'Seattle',
  stateOrRegion: 'WA',
  postalCode:    '98109',
  countryCode:   'US',
  phone:         '4255551234'
};
const TEST_ITEMS = [
  { sku: TEST_SKU, quantity: 1, sellerSku: TEST_SKU },
  { sku: TEST_SKU_2, quantity: 1, sellerSku: TEST_SKU_2 }
];
// ─────────────────────────────────────────────────────────────────────────────

const c = {
  pass:  (s) => `\x1b[32m✔ ${s}\x1b[0m`,
  fail:  (s) => `\x1b[31m✖ ${s}\x1b[0m`,
  info:  (s) => `\x1b[36mℹ ${s}\x1b[0m`,
  head:  (s) => `\n\x1b[1m\x1b[35m===  ${s}  ===\x1b[0m`,
  warn:  (s) => `\x1b[33m⚠ ${s}\x1b[0m`
};

// ─── 1. CONNECTIVITY CHECK ───────────────────────────────────────────────────
async function testDB() {
  console.log(c.head('DATABASE CONNECTIVITY'));
  try {
    const [rows] = await db.query('SELECT NOW() AS ts');
    console.log(c.pass(`DB connected — server time: ${rows[0].ts}`));
    console.log(c.info(`Using database: ${process.env.DB_NAME} @ ${process.env.DB_HOST}`));
    return true;
  } catch (e) {
    console.log(c.fail(`DB connection failed: ${e.message}`));
    return false;
  }
}

// ─── 2. MCF INVENTORY CHECK ──────────────────────────────────────────────────
async function testInventory() {
  console.log(c.head('MCF INVENTORY CHECK'));
  const skus = [TEST_SKU, TEST_SKU_2];
  try {
    const inv = await mcfService.listInventory(skus);
    if (!inv.length) {
      console.log(c.warn('No inventory returned — ensure your SKUs are FBA-eligible'));
    } else {
      inv.forEach(i => {
        const status = i.quantity > 0 ? c.pass : c.warn;
        console.log(status(`SKU: ${i.sku} | ASIN: ${i.asin} | Quantity: ${i.quantity}`));
      });
    }
    return true;
  } catch (e) {
    console.log(c.fail(`Inventory check failed: ${e.message}`));
    return false;
  }
}

// ─── 3. MCF SHIPPING PREVIEW (rate estimates) ─────────────────────────────────
async function testPreview() {
  console.log(c.head('MCF SHIPPING PREVIEW'));
  try {
    const previews = await mcfService.getFulfillmentPreview(TEST_ADDRESS, TEST_ITEMS);
    if (!previews.length) {
      console.log(c.warn('No previews returned — the address or SKUs may be invalid.'));
    } else {
      previews.forEach(p => {
        const status = p.isFulfillable ? c.pass : c.warn;
        console.log(status(
          `Speed: ${p.shippingSpeedCategory} | Fulfillable: ${p.isFulfillable} | Total Fee: $${p.totalFee.toFixed(2)} ${p.currency}`
        ));
        if (p.fulfillmentPreviewShipments?.[0]) {
          const s = p.fulfillmentPreviewShipments[0];
          console.log(c.info(`  Ships: ${s.earliestShipDate} → Arrives: ${s.latestArrival}`));
        }
      });
    }
    return previews;
  } catch (e) {
    console.log(c.fail(`Preview failed: ${e.message}`));
    return null;
  }
}

// ─── 4. MOCK ORDER CREATION (bypasses PayPal) ────────────────────────────────
async function testOrderCreate() {
  console.log(c.head('ORDER CREATION (No PayPal)'));
  try {
    const order = await Order.createOrder({
      customerId:       null,
      country:          'US',
      customer_email:   'test@detailguardz.com',
      items: TEST_ITEMS.map(i => ({
        variantId:   i.sku,
        productId:   i.sku,
        sku:         i.sku,
        productName: i.sku,
        quantity:    i.quantity,
        unitPrice:   19.99
      })),
      shipping: {
        firstName:  'Test',
        lastName:   'Tester',
        address1:   TEST_ADDRESS.line1,
        address2:   TEST_ADDRESS.line2,
        city:       TEST_ADDRESS.city,
        state:      TEST_ADDRESS.stateOrRegion,
        zip:        TEST_ADDRESS.postalCode,
        phone:      TEST_ADDRESS.phone
      },
      shippingSpeed:     'standard',
      paymentMethod:     'test_bypass',
      paymentReference:  `TEST-${Date.now()}`,
      paymentStatus:     'paid',
      subtotal:          39.98,
      tax:               3.50,
      shippingCost:      0,
      total:             43.48,
      currency:          'USD'
    });

    console.log(c.pass(`Order created — #${order.order_number} (id: ${order.id})`));
    console.log(c.info(`  Payment: ${order.paymentStatus || 'paid'} | Status: ${order.fulfillmentStatus || 'pending'}`));
    return order;
  } catch (e) {
    console.log(c.fail(`Order creation failed: ${e.message}`));
    return null;
  }
}

// ─── 5. MCF FULFILLMENT TRIGGER ──────────────────────────────────────────────
async function testFulfillment(order) {
  console.log(c.head('MCF FULFILLMENT TRIGGER'));
  if (!order) {
    console.log(c.warn('Skipped — no order to fulfill'));
    return;
  }
  try {
    const result = await fulfillOrder(order.id);
    if (result.alreadyFulfilled) {
      console.log(c.warn(`Already fulfilled (status: ${result.status})`));
    } else {
      console.log(c.pass(`Fulfillment triggered! Channel: ${result.fulfillmentChannel}`));
      if (result.amazonFulfillmentId) {
        console.log(c.info(`  Amazon ID: ${result.amazonFulfillmentId}`));
      }
    }
    return result;
  } catch (e) {
    console.log(c.fail(`Fulfillment failed: ${e.message}`));
    return null;
  }
}

// ─── 6. MCF ORDER STATUS CHECK ───────────────────────────────────────────────
async function testGetFulfillmentStatus(amazonFulfillmentId) {
  console.log(c.head('MCF ORDER STATUS'));
  if (!amazonFulfillmentId) {
    console.log(c.warn('Skipped — no Amazon fulfillment ID available'));
    return;
  }
  try {
    const status = await mcfService.getFulfillmentOrder(amazonFulfillmentId);
    console.log(c.pass(`Status: ${status.status} | Speed: ${status.shippingSpeedCategory}`));
    if (status.primaryTrackingNumber) {
      console.log(c.info(`  Tracking: ${status.primaryTrackingNumber} (${status.primaryCarrier})`));
    }
    return status;
  } catch (e) {
    console.log(c.fail(`Status check failed: ${e.message}`));
    return null;
  }
}

// ─── RUNNER ──────────────────────────────────────────────────────────────────
async function main() {
  const arg = process.argv[2]?.toLowerCase();
  console.log(c.info(`MCF Integration Test — ${new Date().toLocaleString()}`));
  console.log(c.info(`Environment: ${process.env.PAYPAL_ENV || 'sandbox'} | Sandbox: ${process.env.AMAZON_SANDBOX}`));

  const dbOk = await testDB();
  if (!dbOk) {
    process.exit(1);
  }

  let order = null;
  let fulfillResult = null;

  if (!arg || arg === 'inventory') await testInventory();
  if (!arg || arg === 'preview')   await testPreview();

  if (!arg || arg === 'order') {
    order = await testOrderCreate();
    if (order) {
      fulfillResult = await testFulfillment(order);
      if (fulfillResult?.amazonFulfillmentId) {
        await new Promise(r => setTimeout(r, 2000)); // small delay for propagation
        await testGetFulfillmentStatus(fulfillResult.amazonFulfillmentId);
      }
    }
  }

  if (arg === 'cancel') {
    // Pass your Amazon MCF ID as the second arg: node test-mcf.js cancel <id>
    const id = process.argv[3];
    if (!id) {
      console.log(c.fail('Usage: node test-mcf.js cancel <sellerFulfillmentOrderId>'));
    } else {
      console.log(c.head('MCF CANCEL ORDER'));
      try {
        await mcfService.cancelFulfillmentOrder(id);
        console.log(c.pass(`Cancel submitted for: ${id}`));
      } catch (e) {
        console.log(c.fail(`Cancel failed: ${e.message}`));
      }
    }
  }

  console.log('\n' + c.info('Test run complete. Check logs/error.log for detailed errors.'));
  process.exit(0);
}

main().catch(e => {
  console.error(c.fail(`Unhandled error: ${e.message}`));
  process.exit(1);
});
