'use strict';

require('dotenv').config();
const { spApiRequest } = require('../services/spApiClient');
const logger = require('../utils/logger');

/**
 * Amazon SP-API Connection Verifier
 * ────────────────────────────────
 * Run: node scripts/verify-amazon.js
 *
 * This script checks:
 *  1. LWA Access (gets refresh token)
 *  2. IAM User Signature V4
 *  3. Selling Partner Permissions (Fulfillment Outbound)
 */

async function verifyConnection() {
  console.log('\n🔍 [1/3] Checking environment variables...');

  const required = [
    'AMAZON_APP_CLIENT_ID',
    'AMAZON_APP_CLIENT_SECRET',
    'AMAZON_REFRESH_TOKEN',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY'
  ];

  const missing = required.filter(key => !process.env[key]);

  if (missing.length) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }
  console.log('✅ Environment keys found.');

  console.log('\n🔍 [2/3] Attempting Login With Amazon (LWA) refresh...');
  try {
    // Calling inventory as a basic test of connectivity
    const marketplaceId = process.env.AMAZON_MARKETPLACE_ID_US || 'ATVPDKIKX0DER';
    const qs = new URLSearchParams({
      granularityType: 'Marketplace',
      granularityId:   marketplaceId,
      marketplaceIds:  marketplaceId
    });

    const response = await spApiRequest('GET', `/fba/inventory/v1/summaries?${qs.toString()}`);
    console.log('✅ LWA Token refreshed successfully.');

    const summaries = response.data?.payload?.inventorySummaries || [];
    console.log(`✅ SP-API Inventory access confirmed. Found ${summaries.length} items.`);

  } catch (err) {
    console.error('\n❌ LWA Token Refresh FAIILED.');
    if (err.response?.data?.error === 'invalid_grant') {
      console.error('👉 Tip: Your AMAZON_REFRESH_TOKEN might be expired or incorrect.');
    } else {
      console.error('👉 Error Details:', err.spApiError || err.response?.data || err.message);
    }
    process.exit(1);
  }

  console.log('\n🔍 [3/3] Checking Fulfillment Outbound permissions...');
  try {
    // Attempting a simple "List Previews" or "Fulfillment Orders" list
    const response = await spApiRequest('GET', '/fba/outbound/2020-07-01/fulfillmentOrders?queryStartDate=' + new Date(Date.now() - 86400000).toISOString());
    console.log('✅ Fulfillment Outbound role confirmed.');
    console.log('🚀 SYSTEM READY FOR PRODUCTION MCF ORDERS.');

  } catch (err) {
    if (err.spApiStatus === 403) {
      console.error('\n❌ ACCESS DENIED (403).');
      console.error('👉 Tip: Your SP-API app does not have the "Fulfillment Outbound" role enabled in Seller Central.');
    } else {
      console.error('❌ Fulfillment check failed:', err.message);
    }
  }

  console.log('\n--- VERIFICATION FINISHED ---');
}

verifyConnection();
