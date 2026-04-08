import 'dotenv/config';
import { createShipment, refundLabel } from '../services/shippoService.js';
import path from 'path';
import { fileURLToPath } from 'url';

const testOrder = {
  order_number: 'DG-REAL-TEST-' + Date.now().toString().slice(-6),
  shipping_first_name: 'David',
  shipping_last_name: 'Miller',
  shipping_address1: '320 Front St W',
  shipping_city: 'Toronto',
  shipping_province: 'ON',
  shipping_postal_code: 'M5V 3B6',
  shipping_phone: '416-555-0101',
  customer_email: 'test@detailguardz.com',
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
    console.log('Step 1: Purchasing real shipping label...');
    const result = await createShipment(testOrder);
    transactionId = result.transactionId;
    
    console.log('SUCCESS: Label Purchased');
    console.log(` - Transaction ID: ${transactionId}`);
    console.log(` - Carrier:        ${result.carrier}`);
    console.log(` - Service:        ${result.serviceName}`);
    console.log(` - Cost:           ${result.rateAmount} ${result.currency}`);
    console.log(` - Tracking:       ${result.trackingNumber}`);
    console.log(` - Label URL:      ${result.labelUrl}`);

    // Wait 10 seconds to ensure label is fully registered in carrier systems
    console.log('\nWaiting 10 seconds before requesting refund/cancellation...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    // 2. Request Refund
    console.log('\nStep 2: Requesting refund (cancellation)...');
    if (!transactionId) throw new Error('Transaction ID not found for refund.');
    
    const refund = await refundLabel(transactionId);
    
    console.log('SUCCESS: Refund Requested');
    console.log(` - Refund ID:      ${refund.objectId || refund.id}`);
    console.log(` - Refund Status:  ${refund.status}`);
    console.log(` - Created At:     ${refund.objectCreated || refund.created}`);
    
    console.log('\nDONE: The label has been purchased and then immediately cancelled/refunded.');
    console.log('Note: Most carriers (Canada Post/UPS) treat this as a manual review refund request.');

  } catch (err) {
    console.error('\nLifecycle failed:', err.message);
    if (err.stack) console.error(err.stack);
  }
}

runLifecycle();
