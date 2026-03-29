import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const db = (await import('../config/database.js')).default;
const mcfService = (await import('./mcfService.js')).default;

async function viewStock() {
  console.log('🔍 Fetching current Amazon MCF stock levels...\n');
  
  try {
    const [products] = await db.query(`
      SELECT name, amazon_sku, color_options, country 
      FROM products 
      WHERE is_active = 1 AND (country IS NULL OR country IN ('US', 'USA', 'both'))
    `);
    
    const skus = new Set();
    const productInfoMap = {};

    products.forEach(p => {
      if (p.amazon_sku) {
        skus.add(p.amazon_sku);
        productInfoMap[p.amazon_sku] = { name: p.name, type: 'Product' };
      }
      try {
        let colors = p.color_options;
        if (typeof colors === 'string') colors = JSON.parse(colors);
        if (Array.isArray(colors)) {
          colors.forEach(c => {
            if (c.amazon_sku) {
              skus.add(c.amazon_sku);
              productInfoMap[c.amazon_sku] = { name: `${p.name} (${c.name || c.value})`, type: 'Variant' };
            }
          });
        }
      } catch (e) {}
    });

    if (skus.size === 0) {
      console.log('⚠️ No Amazon SKUs found in your USA product database.');
      process.exit(0);
    }

    console.log(`📡 Fetching live inventory from Amazon MCF for ${skus.size} SKUs...\n`);

    // Fetch ALL inventory to see if we are missing anything
    const responseItems = await mcfService.listInventory([]); 
    console.log(`📦 Received ${responseItems.length} inventory summaries from Amazon.`);
    
    const inventoryMap = {};
    responseItems.forEach(item => {
      inventoryMap[item.sku] = item.quantity;
    });
    
    // 1. Primary Report: Our Tracked Products
    const results = Array.from(skus).map(sku => {
      const info = productInfoMap[sku] || { name: 'Unknown', type: '?' };
      const amazonQty = inventoryMap[sku];
      
      let status = '❌ OUT OF STOCK';
      let qty = 0;
      
      if (amazonQty !== undefined) {
        qty = amazonQty;
        status = qty > 0 ? '✅ IN STOCK' : '❌ OUT OF STOCK';
      } else {
        status = '⚠️ NOT FOUND ON AMAZON';
      }

      return {
        Product: info.name.substring(0, 80),
        Type: info.type,
        SKU: sku,
        Quantity: qty,
        Status: status
      };
    }).sort((a, b) => a.Product.localeCompare(b.Product));

    console.table(results);

    // 2. Extra Report: What else is on Amazon?
    const extraAmazonItems = responseItems.filter(item => !skus.has(item.sku));
    if (extraAmazonItems.length > 0) {
      console.log(`\n📦 Extra items found on Amazon (NOT currently in our database):`);
      console.table(extraAmazonItems.map(item => ({
        SKU: item.sku,
        ASIN: item.asin,
        FNSKU: item.fnsku,
        Quantity: item.quantity
      })));
    }

    const totalInStock = results.filter(r => r.Quantity > 0).length;
    const totalFound = results.filter(r => r.Status !== '⚠️ NOT FOUND ON AMAZON').length;
    
    console.log(`\n📊 Summary:`);
    console.log(` - Total items checked: ${results.length}`);
    console.log(` - Items successfully found on Amazon: ${totalFound}`);
    console.log(` - Items currently in stock: ${totalInStock}`);

  } catch (err) {
    console.error('❌ Error fetching MCF stock:', err.message);
  } finally {
    process.exit(0);
  }
}

viewStock();
