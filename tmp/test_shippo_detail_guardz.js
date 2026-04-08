import { getShippingRates } from '../services/shippoService.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

// Product Data provided by user
const productDetail = {
  brand: 'DETAIL GUARDZ',
  material: 'Plastic (High-Strength Resin)',
  weight: '490 Grams (1.08 lbs)',
  dimensions_str: '10.43"L x 10.43"W x 2.56"H',
  capacity: '5 Gallons',
  itemDiameter: '10.3 Inches'
};

// Conversions for Shippo (Service expects kg and cm)
// 490 Grams -> 0.49 kg
// 10.43 Inches -> 26.5 cm
// 2.56 Inches -> 6.5 cm

const testOrder = {
  shipping_first_name: 'David',
  shipping_last_name: 'Miller',
  shipping_address1: '123 Fake St',
  shipping_city: 'Ottawa',
  shipping_province: 'ON',
  shipping_postal_code: 'K1P 5J2',
  items: [
    {
      sku: 'DG-GUARD-001',
      productName: 'DETAIL GUARDZ - High-Strength Resin Guard',
      quantity: 1,
      unitPrice: 29.99,
      weightKg: 0.490, // 490 Grams
      dimensions: '26.5x26.5x6.5' // 10.43" x 10.43" x 2.56" converted to cm
    }
  ]
};

async function runTest() {
  try {
    console.log('--- DETAIL GUARDZ - Shipping Rate Calculation ---');
    console.log(`Product:   ${productDetail.brand}`);
    console.log(`Weight:    ${productDetail.weight}`);
    console.log(`Dims:      ${productDetail.dimensions_str}`);
    console.log(`Route:     Mississauga (ON) -> Ottawa (ON)`);
    
    console.log('\nProcessing Canadian digits and dimensions...');
    const rates = await getShippingRates(testOrder);
    
    console.log(`\nFound ${rates.length} valid rates:`);
    rates.forEach(r => {
      console.log(` - ${r.serviceName.padEnd(25)} (${r.provider.padEnd(12)}): ${r.amount.toFixed(2).padStart(6)} ${r.currency}`);
    });

  } catch (err) {
    console.error('\nCalculation failed:', err.message);
  }
}

runTest();
