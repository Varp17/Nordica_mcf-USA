'use strict';
require('dotenv').config();
const db = require('../config/database');

async function updateDirtLockSkus() {
    try {
        console.log('--- STARTING SKU UPDATE (US ONLY) ---');

        // Step 1: Clear any existing instances of these SKUs to prevent UNIQUE constraint errors
        await db.query(`
            UPDATE product_variants 
            SET amazon_sku = NULL 
            WHERE amazon_sku IN ('DLRP-BLACK-1-stickerless', 'DLRP-BLUE-3-stickerless')
        `);
        console.log('Cleared existing SKUs to avoid duplicates.');

        // Step 2: Update specific US variants
        // Black
        const [blackRes] = await db.query(`
            UPDATE product_variants 
            SET amazon_sku = 'DLRP-BLACK-1-stickerless'
            WHERE product_id = 'Dirt-Lock-Insert' AND country = 'US' AND color = 'black'
        `);
        console.log(`Updated Black variant: ${blackRes.affectedRows} row(s)`);

        // Blue
        const [blueRes] = await db.query(`
            UPDATE product_variants 
            SET amazon_sku = 'DLRP-BLUE-3-stickerless'
            WHERE product_id = 'Dirt-Lock-Insert' AND country = 'US' AND color = 'blue'
        `);
        console.log(`Updated Blue variant: ${blueRes.affectedRows} row(s)`);

        console.log('--- UPDATE FINISHED ---');
        process.exit(0);
    } catch (err) {
        console.error('CRITICAL UPDATE ERROR:', err.message);
        process.exit(1);
    }
}

updateDirtLockSkus();
