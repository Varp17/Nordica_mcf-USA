import { getShippo } from '../services/shippoService.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

async function checkLatestTransactions() {
  const shippo = getShippo();
  try {
    console.log('Fetching latest 5 transactions...');
    const result = await shippo.transactions.list({ results: 5 });
    
    // In SDK v2, result might be a page of transactions
    const list = result.results || [];
    
    list.forEach(t => {
      console.log(`- ID: ${t.objectId}, Status: ${t.status}, Tracking: ${t.trackingNumber}, Created: ${t.objectCreated}`);
    });
    
  } catch (err) {
    console.error('Error fetching transactions:', err.message);
  }
}

checkLatestTransactions();
