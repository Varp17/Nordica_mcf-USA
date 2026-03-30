import db from './config/database.js';
import Order from './models/Order.js';
import logger from './utils/logger.js';

async function verifyOrderCreation() {
  console.log('--- Order Verification Starting ---');
  
  const mockOrderData = {
    country: 'US', // Focus: USA
    customer_email: 'uscustomer@gmail.com',
    items: [
      { 
        sku: 'DIRT LOCK-SW180 WHITE', 
        productId: 'dirt-lock-scrub-wall', 
        variantId: 'dirt-lock-scrub-wall::white', 
        productName: 'Dirt Lock Scrub Wall (White)',
        quantity: 1, 
        unitPrice: 19.99,
        totalPrice: 19.99 
      }
    ],
    shipping: {
      firstName: 'USA',
      lastName: 'Customer',
      address1: '310 12th Ave',
      city: 'Santa Cruz',
      state: 'CA', 
      zip: '95062', 
      phone: '1234567890'
    },
    shippingSpeed: 'Standard',
    subtotal: 19.99,
    tax: 0,
    shippingCost: 8.50,
    total: 28.49,
    currency: 'USD'
  };

  try {
    // 1. Test Order Creation (Focused on US storage columns)
    console.log('Testing US order creation for MCF...');
    const order = await Order.createOrder(mockOrderData);
    
    if (order.shipping_zip === '95062' && order.shipping_state === 'CA') {
      console.log('✅ US Parameter Matching: SUCCESS');
    } else {
      console.error('❌ US Parameter Matching: FAILED');
      console.error(`Result: Zip: ${order.shipping_zip}, State: ${order.shipping_state}`);
    }

    // 2. Test JSON Address Integrity (Mirroring what MCF Service reads)
    let addrBlob;
    try { 
      addrBlob = typeof order.shipping_address === 'string' ? JSON.parse(order.shipping_address) : order.shipping_address; 
    } catch (e) { console.error('Parse error:', e.message); }
    
    if (addrBlob && (addrBlob.zip === '95062' || addrBlob.postalCode === '95062')) {
      console.log('✅ JSON Address Mapping: SUCCESS');
    } else {
      console.error('❌ JSON Address Mapping: FAILED');
      console.log('Order keys:', Object.keys(order).filter(k => k.startsWith('shipping')));
      console.log('Raw address field:', order.shipping_address);
    }

    console.log('--- Cleanup ---');
    await db.execute('DELETE FROM order_items WHERE order_id = ?', [order.id]);
    await db.execute('DELETE FROM orders WHERE id = ?', [order.id]);
    console.log('Verification finished successfully.');
    
  } catch (err) {
    console.error('❌ Verification Error:', err.message);
  } finally {
    process.exit();
  }
}

verifyOrderCreation();
