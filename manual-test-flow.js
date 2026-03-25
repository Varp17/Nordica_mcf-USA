'use strict';

/**
 * Manual Test Flow - Steps 1 to 3
 * ──────────────────────────────
 * 1. Customer places order (Mocked)
 * 2. Check Inventory in SP-API
 * 3. Get Fulfillment Preview
 */

import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import mcfService from './services/mcfService.js';
import logger from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTestFlow() {
  console.log('--- STARTING MANUAL TEST FLOW (STEPS 1-3) ---\n');

  // REAL FBA SKUs from your Seller Central account
  const websiteOrder = {
    orderId: "WEB-TEST-001",
    customer: {
      name: "John Smith",
      address: "123 Main Street",
      city: "New York",
      state: "NY",
      zip: "10001",
      country: "US"
    },
    items: [
      {
        sellerSku: "DLRP-BLACK-1-stickerless",
        quantity: 1
      }
    ]
  };

  console.log('STEP 1: Order received from website:');
  console.log(JSON.stringify(websiteOrder, null, 2));
  console.log('\n------------------------------------------------\n');

  // STEP 2: Check inventory in Amazon FBA
  const sku = websiteOrder.items[0].sellerSku;
  console.log(`STEP 2: Checking Amazon FBA Inventory for SKU: ${sku}...`);

  try {
    const inventory = await mcfService.listInventory([sku]);

    if (inventory && inventory.length > 0) {
      const item = inventory[0];
      console.log('✅ Inventory check results:');
      console.log(`   SKU: ${item.sku}`);
      console.log(`   ASIN: ${item.asin}`);
      console.log(`   Fulfillable Quantity: ${item.quantity}`);

      if (item.quantity < websiteOrder.items[0].quantity) {
        console.log('⚠️  CRITICAL: Not enough stock in Amazon FBA!');
        return;
      }
    } else {
      console.log(`⚠️  SKU ${sku} not found in Amazon FBA inventory. Check if SKU is correct.`);
      // We will still try step 3 to see if deliverability works even if inventory check is picky
    }
  } catch (err) {
    console.error('❌ Error in STEP 2 (Inventory Check):');
    console.error(err.message);
    // Continue to step 3 to test connection
  }

  console.log('\n------------------------------------------------\n');

  // STEP 3: Get shipping cost preview
  console.log('STEP 3: Fetching Fulfillment Preview (Deliverability & Fees)...');

  const address = {
    name: websiteOrder.customer.name,
    line1: websiteOrder.customer.address || "Default Address",
    city: websiteOrder.customer.city,
    stateOrRegion: websiteOrder.customer.state,
    postalCode: websiteOrder.customer.zip,
    countryCode: 'US'
  };

  try {
    const previews = await mcfService.getFulfillmentPreview(address, websiteOrder.items.map(i => ({
  sellerSku: i.sellerSku,
  quantity: i.quantity
})));

    if (previews && previews.length > 0) {
      console.log('✅ Fulfillment Preview Successful!');
      previews.forEach((p, idx) => {
        console.log(`\nOption ${idx + 1}: ${p.shippingSpeedCategory}`);
        console.log(`   Fulfillable: ${p.isFulfillable ? 'YES' : 'NO'}`);

        if (p.estimatedFees && p.estimatedFees.length > 0) {
          console.log('   Estimated Fees:');
          p.estimatedFees.forEach(f => {
            console.log(`      - ${f.name}: ${f.amount.value} ${f.amount.currencyCode}`);
          });
        }

        if (p.fulfillmentPreviewShipments && p.fulfillmentPreviewShipments.length > 0) {
          const ship = p.fulfillmentPreviewShipments[0];
          console.log(`   Estimated Delivery: ${ship.earliestArrival} to ${ship.latestArrival}`);
        }
      });
    } else {
      console.log('❌ No fulfillment options returned. Item may not be deliverable to this address or restricted.');
    }
  } catch (err) {
    console.error('❌ Error in STEP 3 (Fulfillment Preview):');
    console.error(err.message);
    if (err.response && err.response.data) {
      console.error('API Response:', JSON.stringify(err.response.data, null, 2));
    }
  }

  console.log('\n------------------------------------------------');
  console.log('🏁 Manual Test Flow for Steps 1-3 Complete.');
  process.exit(0);
}

runTestFlow();
