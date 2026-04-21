
import 'dotenv/config';
import db from '../config/database.js';
import { fulfillOrder } from '../services/fulfillmentService.js';
import logger from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

async function testShippoMulti() {
  console.log('Starting Shippo Multi-Item Workflow Test...');
  
  const customerEmail = 'k7391356@gmail.com';
  const orderNumber = 'MULTI-' + Math.floor(Math.random() * 1000000);
  const orderId = uuidv4();
  
  // 1. Fetch some products
  const [products] = await db.query(
    "SELECT id, name, sku, canada_sku, price, weight_kg, dimensions FROM products WHERE target_country IN ('canada', 'both') LIMIT 3"
  );
  
  if (products.length < 2) {
    console.error('Not enough Canadian products found in database for multi-test.');
    process.exit(1);
  }
  
  console.log(`Using ${products.length} different products.`);

  const shippingAddress = {
    firstName: 'Jane',
    lastName: 'Multi',
    address1: '123 Warehouse St',
    city: 'Toronto',
    province: 'ON',
    postalCode: 'M5H 2N2',
    country: 'CA',
    phone: '4165559999'
  };

  try {
    // 2. Create Order in DB
    console.log(`Creating multi-item order ${orderNumber}...`);
    await db.query(`
      INSERT INTO orders (
        id, order_number, customer_email, 
        shipping_first_name, shipping_last_name, shipping_address1, 
        shipping_city, shipping_province, shipping_postal_code, 
        shipping_phone, shipping_address,
        subtotal, tax, shipping_cost, total, currency,
        status, payment_status, fulfillment_status, country, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      orderId, orderNumber, customerEmail,
      shippingAddress.firstName, shippingAddress.lastName, shippingAddress.address1,
      shippingAddress.city, shippingAddress.province, shippingAddress.postalCode,
      shippingAddress.phone, JSON.stringify(shippingAddress),
      50.00, 6.50, 15.00, 71.50, 'CAD',
      'pending', 'paid', 'pending', 'CA', 'Multi-Item Shippo Workflow Test'
    ]);

    // 3. Create Order Items in DB
    for (const [index, product] of products.entries()) {
      const qty = index + 1; // 1, 2, 3
      await db.query(`
        INSERT INTO order_items (
          id, order_id, product_id, sku, product_name, 
          quantity, unit_price, total_price, weight_kg, currency
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        uuidv4(), orderId, product.id, product.canada_sku || product.sku || 'TEST-SKU', product.name,
        qty, product.price, product.price * qty, product.weight_kg || 0.5, 'CAD'
      ]);
      console.log(`Added ${qty}x ${product.name}`);
    }

    console.log(`Order ${orderNumber} created successfully in database.`);

    // 4. Trigger Fulfillment
    console.log(`Triggering fulfillment for multi-item order ${orderId}...`);
    const result = await fulfillOrder(orderId);
    
    console.log('Fulfillment Result:', JSON.stringify(result, null, 2));
    
    // 5. Verify status in DB
    const [orderRows] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    console.log('Final Order Status in DB:', {
      fulfillment_status: orderRows[0].fulfillment_status,
      shippo_order_id: orderRows[0].shippo_order_id,
      actual_shipping_cost: orderRows[0].actual_shipping_cost,
      shipping_profit_loss: orderRows[0].shipping_profit_loss
    });

  } catch (err) {
    console.error('Multi-Item Test Failed:', err);
  } finally {
    process.exit(0);
  }
}

testShippoMulti();
