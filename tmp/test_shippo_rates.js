import { getShippingRates } from '../services/shippoService.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const testOrder = {
  shipping_first_name: 'Test',
  shipping_last_name: 'User',
  shipping_address1: '30 Bond St',
  shipping_city: 'Toronto',
  shipping_province: 'ON',
  shipping_postal_code: 'M5B 1W8',
  items: [
    {
      sku: 'cad-tshirt-blue',
      productName: 'Blue North T-Shirt',
      quantity: 1,
      unitPrice: 25.00,
      weightKg: 0.3,
      dimensions: '20x15x5'
    }
  ]
};

async function runTest() {
  try {
    console.log('--- Shippo Live Rate Test ---');
    console.log('From Address:', process.env.SHIPPO_FROM_STREET1, process.env.SHIPPO_FROM_CITY, process.env.SHIPPO_FROM_ZIP);
    console.log('To Address:  ', testOrder.shipping_address1, testOrder.shipping_city, testOrder.shipping_postal_code);
    
    const rates = await getShippingRates(testOrder);
    console.log(`Found ${rates.length} valid rates:`);
    rates.forEach(r => {
      console.log(` - ${r.serviceName} (${r.provider}): ${r.amount} ${r.currency}`);
    });

    if (rates.length === 0) {
      console.log('No valid rates were returned. This might be due to carrier configuration or address issues.');
    }
  } catch (err) {
    console.error('Test failed:', err.message);
  }
}

runTest();
