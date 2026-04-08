import { getShippingRates } from '../services/shippoService.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const testOrder = {
  shipping_first_name: 'John',
  shipping_last_name: 'Doe',
  shipping_address1: '750 Burrard St',
  shipping_city: 'Vancouver',
  shipping_province: 'BC',
  shipping_postal_code: 'V6Z 2S8',
  items: [
    {
      sku: 'NP-PLASTIC-SHEET-001',
      productName: 'Industrial Plastic Sheet - High Density',
      quantity: 2,
      unitPrice: 45.00,
      weightKg: 2.5,
      dimensions: '50x40x10'
    },
    {
      sku: 'NP-MOLD-PART-005',
      productName: 'Custom Molded Plastic Part',
      quantity: 1,
      unitPrice: 120.00,
      weightKg: 5.0,
      dimensions: '30x30x30'
    }
  ]
};

async function runTest() {
  try {
    console.log('--- Shippo Canadian Product Rate Preview ---');
    console.log('From: Mississauga Warehouse (1905 Sismet Rd)');
    console.log('To:   Vancouver Customer (750 Burrard St)');
    console.log('Items:');
    testOrder.items.forEach(item => {
      console.log(` - ${item.quantity}x ${item.productName} (${item.weightKg}kg, ${item.dimensions}cm)`);
    });
    
    console.log('\nFetching rates...');
    const rates = await getShippingRates(testOrder);
    
    console.log(`\nFound ${rates.length} valid rates:`);
    rates.forEach(r => {
      console.log(` - ${r.serviceName.padEnd(30)} (${r.provider.padEnd(12)}): ${r.amount.toFixed(2).padStart(6)} ${r.currency} (Est. ${r.estimatedDays || '?'} days)`);
    });

  } catch (err) {
    console.error('\nPreview failed:', err.message);
    if (err.stack) console.error(err.stack);
  }
}

runTest();
