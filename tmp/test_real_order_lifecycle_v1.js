import { createShipment, refundLabel } from '../services/shippoService.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const testOrder = {
  order_number: 'TEST-LIFECYCLE-' + Date.now(),
  shipping_first_name: 'David',
  shipping_last_name: 'Miller',
  shipping_address1: '123 Fake St',
  shipping_city: 'Toronto',
  shipping_province: 'ON',
  shipping_postal_code: 'M5V 2H1',
  shipping_phone: '416-555-0199',
  customer_email: 'test-shippo@example.com',
  items: [
    {
      sku: 'DG-GUARD-001',
      productName: 'DETAIL GUARDZ - Guard',
      quantity: 1,
      weightKg: 0.490,
      dimensions: '26.5x26.5x6.5'
    }
  ]
};

async function runLifecycle() {
  let transactionId = null;

  try {
    console.log('\n--- Real Shippo Order & Cancellation Lifecycle ---');
    console.log('Mode: LIVE (Real Charge Expected)');
    console.log(`Order: ${testOrder.order_number}\n`);

    // 1. Create Shipment & Purchase Label
    console.log('Step 1: Purchasing shipping label...');
    const result = await createShipment(testOrder);
    transactionId = result.trackingNumber; // Wait, trackingNumber is returned, but we need transaction objectId for refund if it's not the same
    
    // Actually, createShipment returns trackingNumber, trackingUrl, labelUrl, etc.
    // We need to modify createShipment to return transactionId (objectId) as well, 
    // or search for it.
    
    console.log('SUCCESS: Label Purchased');
    console.log(` - Carrier: ${result.carrier}`);
    console.log(` - Service: ${result.serviceName}`);
    console.log(` - Cost:    ${result.rateAmount} ${result.currency}`);
    console.log(` - Tracking: ${result.trackingNumber}`);
    console.log(` - Label:    ${result.labelUrl}`);

    // Wait 5 seconds to let Shippo/Carrier process
    console.log('\nWaiting 5 seconds before cancellation...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 2. Request Refund
    console.log('\nStep 2: Requesting refund (cancellation)...');
    // Note: createShipment needs to be updated to return transaction's objectId
    // I will modify createShipment first.
    
  } catch (err) {
    console.error('\nLifecycle failed:', err.message);
  }
}

// runLifecycle();
